#!/usr/bin/env node
// Round 6: regression tests for the citation-stripping contract and the
// terminateChild SIGTERM→SIGKILL fallback. Runs via `npm test` and in CI.
//
// Uses node:test (built-in, zero deps) and asserts each Oracle finding
// across rounds 2–6 still holds. Add a case per finding when adding a fix.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  stripCode,
  stripInlineCodeSpans,
  hasValidInlineCitation,
  validateCitations,
  parseAndValidate,
  parseArgs,
  terminateChild,
} from '../bin/gemini-search.mjs';

test('stripCode: fenced block citations are dropped', () => {
  const md = '```\n[Source](https://x.com)\n```\n[Source](https://y.com)\n## Sources';
  const out = stripCode(md);
  assert.match(out, /https:\/\/y\.com/);
  assert.doesNotMatch(out, /https:\/\/x\.com/);
});

test('stripCode: unclosed fenced block swallows everything to EOF', () => {
  const md = '```\n[Source](https://x.com)\n## Sources\n* https://x.com';
  const out = stripCode(md);
  assert.doesNotMatch(out, /https:\/\/x\.com/);
  assert.doesNotMatch(out, /## Sources/);
});

test('stripCode: indented code block (4-space) citations are dropped', () => {
  // CommonMark §4.4 — paragraph break, then 4-space indented code.
  const md = 'intro paragraph\n\n    [Source](https://example.com)\n\nreal text\n## Sources';
  const out = stripCode(md);
  assert.doesNotMatch(out, /https:\/\/example\.com/);
});

test('stripCode: indented code block (tab) citations are dropped', () => {
  const md = 'intro\n\n\t[Source](https://example.com)\n\nafter\n## Sources';
  const out = stripCode(md);
  assert.doesNotMatch(out, /https:\/\/example\.com/);
});

test('stripCode: HTML <pre> block citations are dropped', () => {
  const md = '<pre>[Source](https://example.com)</pre>\n## Sources';
  const out = stripCode(md);
  assert.doesNotMatch(out, /https:\/\/example\.com/);
});

test('stripCode: HTML <code> block citations are dropped', () => {
  const md = '<code class="x">[Source](https://example.com)</code>\n## Sources';
  const out = stripCode(md);
  assert.doesNotMatch(out, /https:\/\/example\.com/);
});

test('stripCode: CRLF line endings normalized', () => {
  const md = '```\r\n[Source](https://x.com)\r\n```\r\nreal [Source](https://y.com)\r\n## Sources';
  const out = stripCode(md);
  assert.doesNotMatch(out, /https:\/\/x\.com/);
  assert.match(out, /https:\/\/y\.com/);
});

test('stripCode: BOM at start is stripped', () => {
  const md = '\uFEFF[Source](https://x.com)\n## Sources';
  const out = stripCode(md);
  assert.match(out, /https:\/\/x\.com/);
});

test('stripCode: paragraph continuation NOT treated as indented code', () => {
  // 4-space-indented paragraph continuation must remain a citation.
  const md = 'real text [Source](https://x.com)\n    continued line\n## Sources';
  const out = stripCode(md);
  assert.match(out, /https:\/\/x\.com/);
});

test('stripInlineCodeSpans: single-backtick span stripped', () => {
  assert.equal(stripInlineCodeSpans('foo `[Source](http://x)` bar'), 'foo  bar');
});

test('stripInlineCodeSpans: double-backtick span stripped', () => {
  assert.equal(stripInlineCodeSpans('foo ``[Source](http://x)`` bar'), 'foo  bar');
});

test('stripInlineCodeSpans: triple-backtick inline span stripped', () => {
  assert.equal(stripInlineCodeSpans('foo ```x``y``` bar'), 'foo  bar');
});

test('stripInlineCodeSpans: unbalanced backticks preserved as literal', () => {
  assert.equal(stripInlineCodeSpans('foo `[Source](http://x) bar'), 'foo `[Source](http://x) bar');
});

test('hasValidInlineCitation: rejects non-http(s) URLs', () => {
  assert.equal(hasValidInlineCitation('[Source](javascript:alert(1))'), false);
  assert.equal(hasValidInlineCitation('[Source](file:///etc/passwd)'), false);
  assert.equal(hasValidInlineCitation('[Source](data:text/html,foo)'), false);
});

test('hasValidInlineCitation: accepts http and https', () => {
  assert.equal(hasValidInlineCitation('[Source](http://x.com)'), true);
  assert.equal(hasValidInlineCitation('[Source](https://x.com/path?q=1)'), true);
});

test('hasValidInlineCitation: image syntax does NOT count', () => {
  assert.equal(hasValidInlineCitation('![Source](https://x.com)'), false);
});

test('validateCitations: throws when no inline citation present', () => {
  assert.throws(() => validateCitations('plain text\n## Sources'),
    /did not include any inline.*citations/);
});

test('validateCitations: throws when no Sources section', () => {
  assert.throws(() => validateCitations('[Source](https://x.com)\nno heading'),
    /did not include a "## Sources" section/);
});

test('validateCitations: passes for well-formed response', () => {
  validateCitations('Real text [Source](https://x.com)\n\n## Sources\n* https://x.com');
});

test('validateCitations: rejects citation hidden in fenced block', () => {
  assert.throws(() => validateCitations('```\n[Source](https://x.com)\n```\n## Sources'),
    /did not include any inline/);
});

test('validateCitations: rejects citation hidden in <pre>', () => {
  assert.throws(() => validateCitations('<pre>[Source](https://x.com)</pre>\n## Sources'),
    /did not include any inline/);
});

test('parseAndValidate: rejects malformed JSON', () => {
  assert.throws(() => parseAndValidate('{not valid json'),
    /returned invalid JSON/);
});

test('parseAndValidate: rejects empty response', () => {
  assert.throws(() => parseAndValidate('{"response":""}'),
    /empty response/);
});

test('parseAndValidate: rejects data.error string', () => {
  assert.throws(() => parseAndValidate('{"error":"quota exceeded"}'),
    /quota exceeded/);
});

test('parseAndValidate: rejects data.error object', () => {
  assert.throws(() => parseAndValidate('{"error":{"message":"server fault"}}'),
    /server fault/);
});

test('parseArgs: -- separator drains remaining argv as positional', () => {
  const opts = parseArgs(['--', '-foo', 'bar']);
  assert.equal(opts.query, '-foo bar');
  assert.equal(opts.help, false);
});

test('parseArgs: --raw and --stream rejected together', () => {
  assert.throws(() => parseArgs(['--raw', '--stream', 'q']),
    /--raw and --stream cannot be used together/);
});

test('parseArgs: --stdin sets fromStdin', () => {
  const opts = parseArgs(['--stdin']);
  assert.equal(opts.fromStdin, true);
});

test('parseArgs: unknown option throws', () => {
  assert.throws(() => parseArgs(['--bogus']), /Unknown option/);
});

test('terminateChild: resolves immediately for already-exited child', async (t) => {
  const child = spawn(process.execPath, ['-e', '0']);
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  });
  await new Promise((r) => child.once('exit', r));
  const start = Date.now();
  await terminateChild(child);
  assert.ok(Date.now() - start < 100, 'should resolve fast for exited child');
});

test('terminateChild: kills a SIGTERM-trapping child via SIGKILL fallback', async (t) => {
  const child = spawn(process.execPath, ['-e', `
    let trapped = 0;
    process.on('SIGTERM', () => { trapped++; });
    setInterval(() => {}, 50);
    process.stdout.write('ready\\n');
  `]);
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child never emitted ready')), 5000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
  });
  await ready;
  const start = Date.now();
  await terminateChild(child, { graceMs: 250 });
  const elapsed = Date.now() - start;
  assert.ok(child.exitCode !== null || child.signalCode !== null,
    'child should be dead after terminateChild');
  assert.equal(child.signalCode, 'SIGKILL', 'child should die by SIGKILL');
  assert.ok(elapsed >= 200 && elapsed < 5000,
    `expected 200ms-5s for grace+kill, got ${elapsed}ms`);
});

test('stripCode: blockquoted indented code citations are dropped (R7)', () => {
  const md = 'intro\n\n>     [Source](https://x.com)\n\nafter\n## Sources';
  const out = stripCode(md);
  assert.doesNotMatch(out, /https:\/\/x\.com/, 'blockquoted indented code must be stripped');
});

test('stripCode: blockquoted fenced code citations are dropped (R7)', () => {
  const md = '> ```\n> [Source](https://x.com)\n> ```\n\n## Sources';
  const out = stripCode(md);
  assert.doesNotMatch(out, /https:\/\/x\.com/, 'blockquoted fenced code must be stripped');
});

test('stripCode: HTML comments hide citations (R7)', () => {
  const md = '<!-- [Source](https://x.com) -->\n\n## Sources';
  const out = stripCode(md);
  assert.doesNotMatch(out, /https:\/\/x\.com/, 'HTML comment content must be stripped');
});

test('stripCode: <script> block hides citations (R7)', () => {
  const md = '<script>[Source](https://x.com)</script>\n## Sources';
  const out = stripCode(md);
  assert.doesNotMatch(out, /https:\/\/x\.com/, '<script> block must be stripped');
});

test('stripCode: <style> block hides citations (R7)', () => {
  const md = '<style>/* [Source](https://x.com) */</style>\n## Sources';
  const out = stripCode(md);
  assert.doesNotMatch(out, /https:\/\/x\.com/, '<style> block must be stripped');
});

test('stripCode: unclosed <pre> swallows to EOF (R7)', () => {
  const md = '<pre>[Source](https://x.com)\n## Sources';
  const out = stripCode(md);
  assert.doesNotMatch(out, /https:\/\/x\.com/, 'unclosed <pre> must drop to EOF');
});

test('stripCode: multi-line inline code span hides citation (R7)', () => {
  const md = 'Claim `\n[Source](https://x.com)\n` ends.\n## Sources';
  const out = stripCode(md);
  assert.doesNotMatch(out, /https:\/\/x\.com/, 'multi-line inline code span must be stripped');
});

test('stripCode: HTML <pre> with > inside attribute (R7)', () => {
  const md = '<pre data-foo="a>b">[Source](https://x.com)</pre>\n## Sources';
  const out = stripCode(md);
  assert.doesNotMatch(out, /https:\/\/x\.com/);
});

test('validateCitations: rejects blockquoted indented code (R7)', () => {
  assert.throws(() => validateCitations('intro\n\n>     [Source](https://x.com)\n\n## Sources'),
    /did not include any inline/);
});

test('validateCitations: rejects HTML comment-hidden citation (R7)', () => {
  assert.throws(() => validateCitations('<!-- [Source](https://x.com) -->\n## Sources'),
    /did not include any inline/);
});

test('validateCitations: rejects <script>-hidden citation (R7)', () => {
  assert.throws(() => validateCitations('<script>[Source](https://x.com)</script>\n## Sources'),
    /did not include any inline/);
});

test('CLI: --help works through a symlink (R7 entry-point gate)', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Symlink creation requires elevated privileges on Windows');
    return;
  }
  const here = fileURLToPath(import.meta.url);
  const realBin = resolve(here, '..', '..', 'bin', 'gemini-search.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'gs-symlink-'));
  const link = join(dir, 'gemini-search-symlink.mjs');
  try {
    symlinkSync(realBin, link);
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
      t.skip(`Symlink creation denied: ${err.code}`);
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      return;
    }
    throw err;
  }
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
  const child = spawn(process.execPath, [link, '--help']);
  let stdout = '';
  child.stdout.on('data', (b) => { stdout += b.toString(); });
  const code = await new Promise((resolve) => child.once('close', resolve));
  assert.equal(code, 0, `symlinked CLI --help must exit 0 (got ${code})`);
  assert.match(stdout, /gemini-search/, 'symlinked CLI --help must print usage');
});

test('stripCode: invalid fence-closer keeps code block open (R8)', () => {
  const md = [
    '```',
    'inside code',
    '``` not actually a closer',
    '[Source](https://hidden.example)',
    '```',
    '[Source](https://real.example)',
    '## Sources',
  ].join('\n');
  const out = stripCode(md);
  assert.doesNotMatch(out, /hidden\.example/, 'citation inside still-open fence must be stripped');
  assert.match(out, /real\.example/, 'real citation outside fence must survive');
});

test('stripCode: type-1 HTML closer line is fully consumed (R8)', () => {
  const md = '<pre>\nhidden\n</pre> [Source](https://x.example)\n[Source](https://y.example)\n## Sources';
  const out = stripCode(md);
  assert.doesNotMatch(out, /x\.example/, 'citation on the </pre> line must be consumed');
  assert.match(out, /y\.example/, 'real citation on next line must survive');
});

test('stripCode: type-6 HTML block with quoted > in attribute (R8)', () => {
  const md = '<div title="a>b">\n[Source](https://hidden.example)\n</div>\n\n[Source](https://real.example)\n## Sources';
  const out = stripCode(md);
  assert.doesNotMatch(out, /hidden\.example/, 'attribute-quoted > must not break block detection');
  assert.match(out, /real\.example/);
});

test('stripCode: unclosed <pre> inside fenced block does not swallow real citations (R8)', () => {
  const md = '```\n<pre>\nstuff\n```\n[Source](https://real.example)\n## Sources';
  const out = stripCode(md);
  assert.match(out, /real\.example/, 'fenced code is stripped first; <pre> inside it is inert');
});

test('main: rejects oversize query (R8)', async (t) => {
  const here = fileURLToPath(import.meta.url);
  const realBin = resolve(here, '..', '..', 'bin', 'gemini-search.mjs');
  const child = spawn(process.execPath, [realBin, 'x'.repeat(40000)], {
    env: { ...process.env, GEMINI_SEARCH_MAX_QUERY_CHARS: '32768' },
  });
  let stderrBuf = '';
  child.stderr.on('data', (b) => { stderrBuf += b.toString(); });
  const code = await new Promise((resolve) => child.once('close', resolve));
  assert.equal(code, 1, 'oversize query must exit 1');
  assert.match(stderrBuf, /max is 32768/);
});
