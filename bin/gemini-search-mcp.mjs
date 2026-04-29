#!/usr/bin/env node

/**
 * gemini-search-mcp — Stdio MCP server exposing the gemini-search pipeline
 * as a single tool: `gemini_web_search`.
 *
 * Why an MCP server (not a Claude Code "tool"):
 *   Claude Code does not expose a public API for plugins to register
 *   first-class native tools. The supported, contract-stable extension
 *   point for "the model can autonomously invoke this when it needs the
 *   web" is the Model Context Protocol (https://modelcontextprotocol.io).
 *   Once registered (Claude Code auto-registers via plugin.json's
 *   `mcpServers` field on `claude plugin install`), the tool surfaces in
 *   the model's tool list with the same affordance as a built-in tool.
 *
 * Reuse, not reimplementation:
 *   This server delegates to the validated CLI pipeline exported from
 *   `bin/gemini-search.mjs` so the MCP path inherits, byte-for-byte, the
 *   R1–R11 hardening: privacy override (disables Gemini telemetry without
 *   touching ~/.gemini), buffered spawn with SIGTERM→SIGKILL escalation,
 *   JSON envelope validation, anti-hallucination citation contract
 *   (subdomain-aware denylist, byte-identical URLs, set-equality between
 *   inline citations and the Sources section, Sources-is-final, tool-
 *   invocation evidence gating). New code in this file is limited to MCP
 *   protocol glue.
 *
 * Transport: stdio. The Claude Code client spawns this process; JSON-RPC
 * messages flow over stdin/stdout. All diagnostics MUST go to stderr —
 * any byte on stdout that is not a JSON-RPC frame corrupts the protocol
 * stream and disconnects the client.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
// The MCP SDK requires tool input schemas as a Zod raw shape (not raw
// JSON Schema). Zod ships transitively with the SDK so importing it
// here adds zero direct runtime cost. We use Zod v3 (the SDK's primary
// supported version per zod-compat.d.ts).
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { realpathSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stderr } from 'node:process';

import {
  buildPrompt,
  setupPrivacyOverride,
  setupGeminiHomeOverride,
  runGeminiBuffered,
  parseAndValidate,
  formatResponse,
  terminateChild,
  extractErrorMessage,
  DEFAULT_MAX_QUERY_CHARS,
  DEFAULT_MAX_PROMPT_BYTES,
} from './gemini-search.mjs';

// Read package version at startup so MCP `initialize` advertises a
// truthful server identity. Synchronous read is intentional: this runs
// once before the transport is connected, well before any RPC traffic.
function readPackageVersion() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// MCP error result helper. Per MCP spec, tool errors are returned as a
// successful RPC response with `isError: true` so the model can read and
// react to the error message. Throwing instead would surface as a
// protocol-level error and the model would not see the cause.
function toolError(message) {
  return {
    isError: true,
    content: [{ type: 'text', text: `Error: ${message}` }],
  };
}

function toolText(text) {
  return {
    content: [{ type: 'text', text }],
  };
}

// Resolve query length cap from the same env var the CLI honors so the
// MCP path cannot accidentally accept a longer query than the CLI.
function getMaxQueryChars() {
  const v = Number(process.env.GEMINI_SEARCH_MAX_QUERY_CHARS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_QUERY_CHARS;
}
function getMaxPromptBytes() {
  const v = Number(process.env.GEMINI_SEARCH_MAX_PROMPT_BYTES);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_PROMPT_BYTES;
}

// Module-level set of in-flight invocations. Each entry owns a child
// process and a privacy-override cleanup callback. The shutdown handler
// drains this set so SIGTERM/SIGINT during an active tool call cannot
// orphan a gemini child or leak a /tmp/gemini-search-priv-* directory.
// Concurrent tool calls are isolated: each call owns its own entry, and
// removal happens in the handler's finally block before the response is
// returned to the transport.
const activeInvocations = new Set();

async function drainActiveInvocations() {
  // Snapshot first because terminateChild + cleanup mutate the set via
  // the handler's finally clause if the child exits during termination.
  const entries = Array.from(activeInvocations);
  await Promise.all(
    entries.map(async (entry) => {
      try { await terminateChild(entry.child); } catch { /* best-effort */ }
      try { entry.cleanup(); } catch { /* best-effort */ }
      activeInvocations.delete(entry);
    }),
  );
}

// Single-flight tool handler. Each invocation gets its own privacy
// override directory and its own gemini child process; nothing is shared
// across concurrent calls so a burst of tool calls cannot leak each
// other's state. The handler always cleans up its temp dir even on
// error or cancellation, AND registers itself in `activeInvocations`
// so the signal handler can terminate the child + remove the temp dir
// if MCP shutdown lands mid-flight.
async function handleSearch({ query, raw }) {
  if (typeof query !== 'string' || query.length === 0) {
    return toolError('query must be a non-empty string');
  }

  const maxChars = getMaxQueryChars();
  if (query.length > maxChars) {
    return toolError(
      `query is ${query.length} chars; max is ${maxChars}. ` +
      `Set GEMINI_SEARCH_MAX_QUERY_CHARS to override.`,
    );
  }

  const prompt = buildPrompt(query);
  const maxPromptBytes = getMaxPromptBytes();
  const promptBytes = Buffer.byteLength(prompt, 'utf8');
  if (promptBytes > maxPromptBytes) {
    return toolError(
      `prompt is ${promptBytes} bytes; max is ${maxPromptBytes}. ` +
      `Set GEMINI_SEARCH_MAX_PROMPT_BYTES to override.`,
    );
  }

  let privacy;
  let geminiHome;
  try {
    privacy = setupPrivacyOverride();
    geminiHome = setupGeminiHomeOverride();
  } catch (err) {
    try { privacy?.cleanup?.(); } catch { /* best-effort */ }
    try { geminiHome?.cleanup?.(); } catch { /* best-effort */ }
    return toolError(`failed to create Gemini privacy override: ${extractErrorMessage(err)}`);
  }

  // Allocate the invocation entry up front; the child is registered as
  // soon as runGeminiBuffered spawns it (synchronous callback). Cleanup
  // is captured here so the shutdown drain can fire BOTH the privacy
  // settings dir AND the GEMINI_CLI_HOME override (Round 6 R6 P2 D1)
  // without a closure over the local bindings.
  const entry = {
    child: null,
    cleanup: () => {
      try { privacy.cleanup(); } catch { /* best-effort */ }
      try { geminiHome.cleanup(); } catch { /* best-effort */ }
    },
  };
  activeInvocations.add(entry);
  const registerChild = (child) => { entry.child = child; };

  try {
    const result = await runGeminiBuffered(prompt, 'json', privacy.path, registerChild, geminiHome.home);
    // parseAndValidate enforces the citation contract; on violation it
    // throws and we surface the message to the model so it can retry
    // with a clearer query rather than silently emitting bad sources.
    const data = parseAndValidate(result);
    const text = raw === true ? result : formatResponse(data);
    return toolText(text);
  } catch (err) {
    // Best-effort: if the child is still alive when we hit an error
    // path, terminate it so we do not leak a gemini process across MCP
    // calls. Errors from terminateChild are themselves swallowed.
    try { await terminateChild(entry.child); } catch { /* ignore */ }
    return toolError(extractErrorMessage(err));
  } finally {
    activeInvocations.delete(entry);
    try { privacy.cleanup(); } catch { /* best-effort */ }
    try { geminiHome.cleanup(); } catch { /* best-effort */ }
  }
}

async function startServer() {
  const version = readPackageVersion();

  const server = new McpServer(
    {
      name: 'gemini-search',
      version,
    },
    {
      capabilities: { tools: {} },
      // Instruct the model when to reach for this tool. MCP clients
      // surface `instructions` to the model on the initialize handshake.
      instructions:
        'Use the `gemini_web_search` tool whenever you need current, ' +
        'real-world information that may not be in your training data: ' +
        'recent news, latest software versions, current prices, live ' +
        'documentation, evolving best practices, or any fact that could ' +
        'have changed. The tool returns markdown with mandatory inline ' +
        '`[Source](URL)` citations and a final `## Sources` section; the ' +
        'URLs are byte-identical to Google Search grounding results. If ' +
        'the response is the literal token `NO_RESULTS`, the search ' +
        'returned nothing — say so explicitly instead of inventing facts.',
    },
  );

  server.registerTool(
    'gemini_web_search',
    {
      title: 'Gemini Web Search',
      description:
        'Search the live web via Gemini CLI with Google Search grounding. ' +
        'Returns markdown with mandatory inline source citations and a ' +
        'final Sources section. URLs are byte-identical to grounding ' +
        'results — no fabrication. Use for current events, latest ' +
        'versions, recent docs, or any fact that may have changed since ' +
        'training cutoff.',
      // Zod raw shape — the SDK converts this to JSON Schema for the
      // client's tools/list view AND to a runtime validator for the
      // tools/call path, so a malformed argument is rejected before our
      // handler runs.
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe(
            'The natural-language search query. Be specific and include ' +
            'distinguishing keywords; the model is forbidden from ' +
            'answering from memory and must invoke google_web_search.',
          ),
        raw: z
          .boolean()
          .optional()
          .describe(
            'When true, return the raw Gemini JSON envelope instead of ' +
            'rendered markdown. Default false. The envelope is still ' +
            'validated against the citation contract before being ' +
            'returned, so raw mode is safe.',
          ),
      },
      annotations: {
        // MCP annotations let the client/model reason about side effects.
        // Web search is read-only from the user's perspective — it does
        // not modify local state, but it is non-idempotent (live web)
        // and is "open world" (interacts with external systems).
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => handleSearch(args ?? {}),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Diagnostic line to stderr so an operator running the server in a
  // terminal can confirm it started. stdout is reserved for the JSON-RPC
  // frame stream; writing anything else there would desync the client.
  try {
    stderr.write(`gemini-search-mcp v${version} listening on stdio\n`);
  } catch {
    // stderr can EPIPE if the client closes immediately; not fatal.
  }

  // Graceful shutdown on signals. The transport's own cleanup is
  // idempotent so repeated signals do not throw. Order is critical:
  //   1. Drain active invocations (terminate gemini children, remove
  //      privacy temp dirs) BEFORE closing the server transport, so we
  //      never strand a child whose stderr/stdout is being read by a
  //      transport pipe that is about to close.
  //   2. Close the MCP server (idempotent).
  //   3. Re-raise the signal with the default disposition so the parent
  //      (Claude Code) sees the conventional 128+signum exit code.
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { await drainActiveInvocations(); } catch { /* ignore */ }
    try { await server.close(); } catch { /* ignore */ }
    const SIGNUM = { SIGINT: 2, SIGTERM: 15 };
    try {
      // Restore default disposition before re-raising so this listener
      // does not re-trigger and the kernel emits the conventional exit
      // code. Without this, the second SIGTERM hits our once() handler's
      // shuttingDown guard and process.kill becomes a no-op delivery
      // that the runtime ignores, leaving the process to exit(0).
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    } catch {
      process.exit(128 + (SIGNUM[signal] ?? 0));
    }
  };
  process.once('SIGINT', () => { shutdown('SIGINT'); });
  process.once('SIGTERM', () => { shutdown('SIGTERM'); });
}

// Only run when invoked as a script. Mirrors the CLI's symlink-aware
// detection (npm `bin` entries are symlinked on Unix; comparing argv[1]
// to import.meta.url directly never matches once installed).
function isMain() {
  const resolve = (p) => { try { return realpathSync(p); } catch { return p; } };
  return !!process.argv[1]
    && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
}

if (isMain()) {
  startServer().catch((err) => {
    try { stderr.write(`gemini-search-mcp fatal: ${extractErrorMessage(err)}\n`); } catch { /* ignore */ }
    process.exit(1);
  });
}

export { handleSearch, startServer };
