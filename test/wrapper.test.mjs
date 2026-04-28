#!/usr/bin/env node
// Round 6: regression tests for the citation-stripping contract and the
// terminateChild SIGTERM→SIGKILL fallback. Runs via `npm test` and in CI.
//
// Uses node:test (built-in, zero deps) and asserts each Oracle finding
// across rounds 2–6 still holds. Add a case per finding when adding a fix.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  stripCode,
  stripInlineCode,
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

test('stripInlineCode: single-backtick span stripped', () => {
  assert.equal(stripInlineCode('foo `[Source](http://x)` bar'), 'foo  bar');
});

test('stripInlineCode: double-backtick span stripped', () => {
  assert.equal(stripInlineCode('foo ``[Source](http://x)`` bar'), 'foo  bar');
});

test('stripInlineCode: triple-backtick inline span stripped', () => {
  assert.equal(stripInlineCode('foo ```x``y``` bar'), 'foo  bar');
});

test('stripInlineCode: unbalanced backticks preserved as literal', () => {
  assert.equal(stripInlineCode('foo `[Source](http://x) bar'), 'foo `[Source](http://x) bar');
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

test('terminateChild: resolves immediately for already-exited child', async () => {
  const child = spawn(process.execPath, ['-e', '0']);
  await new Promise((r) => child.once('exit', r));
  // Now exitCode is set; terminateChild should resolve without sending a signal.
  const start = Date.now();
  await terminateChild(child);
  assert.ok(Date.now() - start < 100, 'should resolve fast for exited child');
});

test('terminateChild: kills a SIGTERM-trapping child via SIGKILL fallback', async () => {
  // Spawn a child that traps SIGTERM with a noisy handler and stays busy
  // in the event loop. Some Node versions swallow no-op signal handlers
  // as if they were defaults and exit anyway, so we both register a
  // visible handler AND keep the loop pinned with a fast interval.
  const child = spawn(process.execPath, ['-e', `
    let trapped = 0;
    process.on('SIGTERM', () => { trapped++; });
    setInterval(() => {}, 50);
    process.stdout.write('ready\\n');
  `]);
  // Wait until the handler is definitely installed.
  await new Promise((resolve) => {
    child.stdout.once('data', () => resolve());
  });
  const start = Date.now();
  await terminateChild(child, { graceMs: 250 });
  const elapsed = Date.now() - start;
  assert.ok(child.exitCode !== null || child.signalCode !== null,
    'child should be dead after terminateChild');
  assert.equal(child.signalCode, 'SIGKILL', 'child should die by SIGKILL');
  assert.ok(elapsed >= 200 && elapsed < 2000,
    `expected 200ms-2s for grace+kill, got ${elapsed}ms`);
});
