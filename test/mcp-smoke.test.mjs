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
import { mkdtempSync, writeFileSync, chmodSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, '..', 'bin', 'gemini-search-mcp.mjs');

// Build a fake `gemini` shim and put a directory containing it on PATH.
// The shim emits a Gemini CLI JSON envelope on stdout containing a
// google_web_search tool-invocation success and a citation/sources
// pair that satisfies the validator's R3 contract (byte-identical URL,
// inline `[Source](URL)` and final `## Sources` section). Returns
// { binDir, cleanup }. Behavior is selected via env vars set when the
// MCP server is spawned, so a single shim handles success + signal-trap
// scenarios without rebuilding the fixture per test.
function buildFakeGeminiBin() {
  const dir = mkdtempSync(join(tmpdir(), 'gemini-search-fake-bin-'));
  const shim = join(dir, 'gemini');
  // The shim is invoked by spawn(); stdout is consumed by
  // runGeminiBuffered. Mode is `success` (default) or `sleep` for the
  // signal-trap test. In sleep mode the shim ignores SIGTERM long
  // enough that, without the MCP server's drain step, the child would
  // be reaped by the kernel only after the MCP process exited (i.e.
  // orphaned). The shim writes its PID to $FAKE_GEMINI_PID_FILE so the
  // test can `kill -0` it after the MCP process is gone.
  writeFileSync(
    shim,
    `#!/usr/bin/env node
const fs = require('node:fs');
const mode = process.env.FAKE_GEMINI_MODE || 'success';
if (process.env.FAKE_GEMINI_PID_FILE) {
  try { fs.writeFileSync(process.env.FAKE_GEMINI_PID_FILE, String(process.pid)); } catch {}
}
if (mode === 'sleep') {
  // Trap SIGTERM so a naive kill('SIGTERM') from the MCP server does
  // nothing; only SIGKILL (escalation) ends this process. This is the
  // exact failure mode Oracle reproduced.
  process.on('SIGTERM', () => { /* swallow */ });
  // Long sleep — the test's drain assertion fires well before this.
  setTimeout(() => process.exit(0), 60_000);
  return;
}
// Success mode: emit a valid Gemini JSON envelope. The response body
// uses a single grounding URL, one inline citation matching that URL
// byte-for-byte, and a final ## Sources block (R3 set-equality + last
// section invariant).
// Use a real-looking, non-placeholder host: example.com/.org/.net,
// foo.com, bar.com, and your-source.com are all in FORBIDDEN_HOSTS and
// would trip R3-004 even at exact-host depth, masking the success path
// we are trying to test. nodejs.org is a real Node.js project domain
// and not in the denylist.
const url = 'https://nodejs.org/en/blog/release/v24.0.0';
const envelope = {
  response: 'Node.js 24 is the active LTS as of 2026-04-29 [Source](' + url + ').\\n\\n## Sources\\n- [nodejs.org](' + url + ')\\n',
  stats: {
    tools: { byName: { google_web_search: { success: 1, fail: 0 } } },
  },
};
process.stdout.write(JSON.stringify(envelope));
process.exit(0);
`,
    { mode: 0o755 },
  );
  chmodSync(shim, 0o755);
  return {
    binDir: dir,
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}

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

test('MCP: tools/call returns rendered markdown from a valid Gemini envelope', async () => {
  // End-to-end smoke through the validator + formatter using a fake
  // gemini binary that emits a contract-compliant JSON envelope. This
  // proves the MCP path actually reuses parseAndValidate + formatResponse
  // rather than shortcutting them.
  const fake = buildFakeGeminiBin();
  try {
    const child = spawn(process.execPath, [SERVER], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Put the fake shim FIRST so spawn('gemini', ...) resolves to
        // it rather than any real binary on the developer's PATH.
        PATH: `${fake.binDir}:${process.env.PATH ?? ''}`,
        FAKE_GEMINI_MODE: 'success',
        // Keep the cap permissive so the query is accepted.
        GEMINI_SEARCH_MAX_QUERY_CHARS: '1024',
      },
    });
    child.stderr.on('data', () => {});
    child.stderr.on('error', () => {});

    const responses = new Map();
    let buf = '';
    const wantedIds = new Set([1, 2]);
    const done = new Promise((resolve, reject) => {
      child.stdout.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg && wantedIds.has(msg.id)) {
            responses.set(msg.id, msg);
            if (responses.size === wantedIds.size) resolve();
          }
        }
      });
      child.on('error', reject);
      child.on('exit', (code, signal) => {
        if (responses.size < wantedIds.size) {
          reject(new Error(`child exited (code=${code}, signal=${signal}) before all responses arrived`));
        }
      });
      const t = setTimeout(() => reject(new Error('rpc timeout: 10s')), 10_000);
      t.unref();
    });

    child.stdin.write(
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0.0.0' } } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'gemini_web_search', arguments: { query: 'current latest stable Node.js LTS' } } },
      ].map(frame).join(''),
    );

    try {
      await done;
    } finally {
      try { child.stdin.end(); } catch { /* ignore */ }
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      await Promise.race([
        once(child, 'exit'),
        new Promise((r) => { const t = setTimeout(r, 1500); t.unref(); }),
      ]).catch(() => {});
    }

    const call = responses.get(2);
    assert.ok(call, 'tools/call response missing');
    assert.ok(!call.error, `expected no protocol error, got: ${JSON.stringify(call.error)}`);
    assert.ok(call.result, 'result missing');
    assert.notEqual(call.result.isError, true, `expected success, got isError with text: ${call.result.content?.[0]?.text}`);
    const text = call.result.content?.[0]?.text ?? '';
    // Validator + formatter contract: inline citation + Sources section
    // with the byte-identical URL the fake shim emitted.
    assert.match(text, /\[Source\]\(https:\/\/nodejs\.org\/en\/blog\/release\/v24\.0\.0\)/);
    assert.match(text, /## Sources/);
    assert.ok(text.includes('https://nodejs.org/en/blog/release/v24.0.0'), 'Sources URL missing');
  } finally {
    fake.cleanup();
  }
});

test('MCP: SIGTERM during in-flight tool call terminates child and removes privacy temp dir', async () => {
  // Reproduces Oracle R4 Defect #1: without the activeInvocations drain
  // in shutdown(), a SIGTERM mid-call would (a) leave the gemini child
  // alive after the MCP process exits and (b) leak /tmp/gemini-search-priv-*.
  const fake = buildFakeGeminiBin();
  const pidFile = join(fake.binDir, 'child.pid');
  // Snapshot privacy dirs before the test so we only inspect ours.
  const priorDirs = new Set(
    readdirSync(tmpdir())
      .filter((n) => n.startsWith('gemini-search-priv-'))
      .map((n) => join(tmpdir(), n)),
  );

  let child;
  try {
    child = spawn(process.execPath, [SERVER], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: `${fake.binDir}:${process.env.PATH ?? ''}`,
        FAKE_GEMINI_MODE: 'sleep',
        FAKE_GEMINI_PID_FILE: pidFile,
        GEMINI_SEARCH_MAX_QUERY_CHARS: '1024',
      },
      // Detached so the kernel does not auto-deliver our test runner's
      // signals to the MCP child group; the test sends SIGTERM directly
      // to the MCP pid only.
      detached: false,
    });
    child.stderr.on('data', () => {});
    child.stderr.on('error', () => {});

    const initDone = new Promise((resolve) => {
      let buf = '';
      child.stdout.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.id === 1 && msg.result) resolve();
        }
      });
    });

    child.stdin.write(
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0.0.0' } } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
      ].map(frame).join(''),
    );
    await Promise.race([
      initDone,
      new Promise((_r, rej) => { const t = setTimeout(() => rej(new Error('initialize timeout')), 5000); t.unref(); }),
    ]);

    // Fire the long-running tool call. Do NOT await its response; the
    // fake shim sleeps 60s on purpose so the child is in-flight when we
    // signal the server.
    child.stdin.write(
      frame({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'gemini_web_search', arguments: { query: 'sleep test' } } }),
    );

    // Wait until the fake shim has actually started (it writes its pid
    // to disk in the first ~ms). Poll briefly with a hard timeout. The
    // pid file is at most ~6 bytes (a Linux PID) so a synchronous read
    // is fine and avoids a malformed import().then() chain.
    const fakePid = await (async () => {
      const { readFileSync } = await import('node:fs');
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if (existsSync(pidFile)) {
          try {
            const txt = readFileSync(pidFile, 'utf8');
            const n = Number(txt.trim());
            if (Number.isFinite(n) && n > 0) return n;
          } catch { /* shim still writing; retry */ }
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('fake gemini pid file never appeared');
    })();

    // Send SIGTERM to the MCP server while the child is still sleeping.
    child.kill('SIGTERM');

    // Wait for the MCP server to exit fully. With the drain fix, this
    // happens AFTER the gemini child is terminated and the temp dir is
    // removed. The grace must exceed terminateChild's SIGTERM→SIGKILL
    // window (currently 1s); 5s gives ample headroom.
    await Promise.race([
      once(child, 'exit'),
      new Promise((_r, rej) => { const t = setTimeout(() => rej(new Error('MCP server did not exit within 5s of SIGTERM')), 5000); t.unref(); }),
    ]);

    // 1) Fake gemini child must NOT be alive after the MCP process exits.
    //    process.kill(pid, 0) throws ESRCH if the pid is gone, returns
    //    truthy if alive. Allow up to 1s of post-exit grace because
    //    SIGKILL delivery is asynchronous on some kernels.
    let stillAlive = true;
    for (let i = 0; i < 20 && stillAlive; i++) {
      try { process.kill(fakePid, 0); stillAlive = true; } catch { stillAlive = false; }
      if (stillAlive) await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(stillAlive, false, `fake gemini child (pid ${fakePid}) was orphaned by MCP shutdown`);

    // 2) No new gemini-search-priv-* temp dir should remain. We compare
    //    against the snapshot taken before the test, so unrelated dirs
    //    from concurrent test workers cannot cause a false positive.
    const nowDirs = readdirSync(tmpdir())
      .filter((n) => n.startsWith('gemini-search-priv-'))
      .map((n) => join(tmpdir(), n));
    const leaked = nowDirs.filter((d) => !priorDirs.has(d));
    assert.deepEqual(leaked, [], `privacy temp dir leaked across MCP shutdown: ${leaked.join(', ')}`);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }
    fake.cleanup();
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
