// MCP server smoke tests: spawn the stdio server, drive it with raw
// JSON-RPC frames over stdin/stdout, and assert protocol-level
// correctness without touching the network or the real gemini CLI.
//
// Why JSON-RPC over the wire (not direct McpServer instantiation):
// the server only exists as a contract once it is connected to a
// transport; testing the spawned process exercises bin shebang,
// import-graph startup, package.json version read, stderr banner,
// and graceful shutdown paths that an in-process test would skip.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { once } from 'node:events';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, '..', 'bin', 'gemini-search-mcp.mjs');

// LSP-style framing for stdio MCP: messages are newline-delimited JSON
// (NOT the LSP Content-Length framing used by some other JSON-RPC
// transports). The MCP stdio spec mandates one JSON object per line.
function frame(obj) {
  return JSON.stringify(obj) + '\n';
}

// Drives the stdio server through one or more requests and returns the
// matching response objects, indexed by request id. Stops as soon as
// every requested id has a response so the test does not hang waiting
// for stream end.
async function rpc(requests) {
  const requestIds = requests.filter((r) => r.id !== undefined).map((r) => r.id);
  const wantedIds = new Set(requestIds);

  const child = spawn(process.execPath, [SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // Force a tiny query cap so we never accidentally invoke gemini even
    // if a future test path slips through; combined with PATH stripping
    // we make the no-network guarantee defense-in-depth.
    env: { ...process.env, PATH: '/nonexistent', GEMINI_SEARCH_MAX_QUERY_CHARS: '1' },
  });

  // Drain stderr so the child cannot block on a full stderr pipe (the
  // server emits a startup banner; without consuming it, longer-running
  // tests can stall once the OS buffer fills).
  child.stderr.on('data', () => {});
  child.stderr.on('error', () => {});

  const responses = new Map();
  let buf = '';
  let timer;
  let resolveDone;
  let rejectDone;
  const done = new Promise((res, rej) => { resolveDone = res; rejectDone = rej; });

  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) {
        rejectDone(new Error(`malformed JSON-RPC frame: ${line}`));
        return;
      }
      if (msg && msg.id !== undefined && wantedIds.has(msg.id)) {
        responses.set(msg.id, msg);
        if (responses.size === wantedIds.size) resolveDone();
      }
    }
  });
  child.on('error', rejectDone);
  child.on('exit', (code, signal) => {
    if (responses.size < wantedIds.size) {
      rejectDone(new Error(`child exited (code=${code}, signal=${signal}) before all responses arrived`));
    }
  });
  timer = setTimeout(() => rejectDone(new Error('rpc timeout: no response within 5s')), 5000);
  timer.unref();

  // Send all frames in one write so the server sees them atomically and
  // ordering is unambiguous (initialize → initialized → tools/list).
  child.stdin.write(requests.map(frame).join(''));

  try {
    await done;
  } finally {
    clearTimeout(timer);
    try { child.stdin.end(); } catch { /* ignore */ }
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    // Wait briefly for clean exit so the process table does not fill
    // up under repeated test runs.
    await Promise.race([
      once(child, 'exit'),
      new Promise((r) => { const t = setTimeout(r, 1000); t.unref(); }),
    ]).catch(() => {});
  }

  return responses;
}

test('MCP: initialize returns server info and tool capability', async () => {
  const responses = await rpc([
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'smoke-test', version: '0.0.0' },
      },
    },
  ]);

  const init = responses.get(1);
  assert.ok(init, 'initialize response missing');
  assert.equal(init.jsonrpc, '2.0');
  assert.ok(init.result, 'initialize.result missing');
  assert.equal(init.result.serverInfo.name, 'gemini-search');
  assert.match(init.result.serverInfo.version, /^\d+\.\d+\.\d+/);
  assert.ok(init.result.capabilities.tools, 'tools capability missing');
  // The server advertises usage instructions so Claude Code surfaces
  // "use this for current info" guidance to the model on connect.
  assert.match(init.result.instructions, /gemini_web_search/);
});

test('MCP: tools/list exposes gemini_web_search with required schema', async () => {
  const responses = await rpc([
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'smoke-test', version: '0.0.0' },
      },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ]);

  const list = responses.get(2);
  assert.ok(list, 'tools/list response missing');
  assert.ok(Array.isArray(list.result.tools), 'tools array missing');
  const tool = list.result.tools.find((t) => t.name === 'gemini_web_search');
  assert.ok(tool, 'gemini_web_search tool not registered');
  assert.match(tool.description, /Google Search grounding/);
  assert.equal(tool.inputSchema.type, 'object');
  assert.deepEqual(tool.inputSchema.required, ['query']);
  assert.equal(tool.inputSchema.properties.query.type, 'string');
  assert.equal(tool.inputSchema.properties.raw.type, 'boolean');
  // openWorldHint signals to the client that the tool can return
  // different results across calls (live web).
  assert.equal(tool.annotations?.openWorldHint, true);
  assert.equal(tool.annotations?.readOnlyHint, true);
});

test('MCP: tools/call rejects empty query without spawning gemini', async () => {
  const responses = await rpc([
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'smoke-test', version: '0.0.0' },
      },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'gemini_web_search', arguments: { query: '' } },
    },
  ]);

  const call = responses.get(2);
  assert.ok(call, 'tools/call response missing');
  // The Zod input-schema validation catches empty queries BEFORE the
  // handler runs. The SDK reports schema violations as a JSON-RPC error
  // (-32602 Invalid Params) rather than as a tool result with isError;
  // that is the correct MCP-spec behavior — protocol-level argument
  // validation failures are protocol errors. Asserting both shapes
  // future-proofs the test against an SDK behavior change while still
  // proving the no-empty-query contract is enforced.
  if (call.error) {
    assert.equal(call.error.code, -32602);
    assert.match(call.error.message, /at least 1 character|non-empty/i);
  } else {
    assert.ok(call.result, 'expected result envelope or error');
    assert.equal(call.result.isError, true);
    assert.match(call.result.content?.[0]?.text ?? '', /non-empty|at least 1/i);
  }
});

test('MCP: tools/call enforces query length cap before spawning gemini', async () => {
  // PATH=/nonexistent in rpc() ensures gemini cannot be found; combined
  // with GEMINI_SEARCH_MAX_QUERY_CHARS=1 a 2-char query must fail at
  // the validation gate, not at exec. If the cap regression let the
  // call through to spawn, the error message would be about gemini
  // not being found instead of the cap.
  const responses = await rpc([
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'smoke-test', version: '0.0.0' },
      },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'gemini_web_search', arguments: { query: 'ab' } },
    },
  ]);

  const call = responses.get(2);
  assert.ok(call, 'tools/call response missing');
  assert.equal(call.result.isError, true);
  assert.match(
    call.result.content?.[0]?.text ?? '',
    /query is 2 chars; max is 1/,
    'expected query-cap error, got: ' + (call.result.content?.[0]?.text ?? '<empty>'),
  );
});
