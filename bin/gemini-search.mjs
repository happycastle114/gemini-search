#!/usr/bin/env node

/**
 * gemini-search — Web search wrapper around Gemini CLI
 *
 * Calls `gemini --output-format json --prompt "..."` with a search-optimized
 * system prompt that forces Google Search grounding. Parses the JSON response
 * and outputs clean markdown with source citations.
 *
 * Usage:
 *   gemini-search "What is the latest Node.js LTS version?"
 *   gemini-search --model gemini-3-flash "React 19 new features"
 *   gemini-search --raw "query"           # Output raw JSON instead of markdown
 *   gemini-search --stream "query"        # Stream JSON events (JSONL)
 *   echo "query" | gemini-search --stdin  # Read query from stdin
 */

import { execFile } from 'node:child_process';
import { argv, stdin, stdout, stderr, exit } from 'node:process';

const DEFAULT_MODEL = 'gemini-2.5-flash';
const TIMEOUT_MS = 120_000;
const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB

// Search-optimized system prompt that forces web grounding
const SEARCH_SYSTEM_PROMPT = `You are a web search assistant. Your ONLY job is to search the web and return accurate, current information.

MANDATORY RULES:
1. ALWAYS use google_web_search to find current information before answering
2. NEVER answer from your training data alone — always verify with a web search
3. Include source URLs for every claim you make
4. If search results conflict, note the discrepancy and cite both sources
5. Format your response as clean markdown with:
   - A direct answer at the top
   - Supporting details with inline citations [Source](url)
   - A "Sources" section at the bottom listing all URLs used

Current date context: ${new Date().toISOString().split('T')[0]}`;

function parseArgs(args) {
  const opts = {
    query: '',
    model: DEFAULT_MODEL,
    raw: false,
    stream: false,
    fromStdin: false,
    help: false,
  };

  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--model':
      case '-m':
        opts.model = args[++i] || DEFAULT_MODEL;
        break;
      case '--raw':
      case '-r':
        opts.raw = true;
        break;
      case '--stream':
      case '-s':
        opts.stream = true;
        break;
      case '--stdin':
        opts.fromStdin = true;
        break;
      default:
        if (!arg.startsWith('-')) positional.push(arg);
        break;
    }
  }

  opts.query = positional.join(' ');
  return opts;
}

function printHelp() {
  const help = `gemini-search — Web search powered by Gemini CLI

Usage:
  gemini-search "query"                    Search the web
  gemini-search -m gemini-3-flash "query"  Use a specific model
  gemini-search --raw "query"              Output raw JSON response
  gemini-search --stream "query"           Stream JSONL events
  echo "query" | gemini-search --stdin     Read query from stdin

Options:
  -m, --model <model>   Gemini model (default: ${DEFAULT_MODEL})
  -r, --raw             Output raw JSON instead of formatted markdown
  -s, --stream          Use stream-json output format (JSONL events)
      --stdin           Read query from stdin
  -h, --help            Show this help

Environment:
  GEMINI_SEARCH_MODEL   Default model override
  GEMINI_SEARCH_TIMEOUT Timeout in ms (default: ${TIMEOUT_MS})

Examples:
  gemini-search "Latest TypeScript 6.0 features"
  gemini-search --raw "Node.js security advisories 2025"
  gemini-search -m gemini-2.5-pro "Compare Bun vs Deno performance benchmarks"
`;
  stdout.write(help);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    stdin.setEncoding('utf-8');
    stdin.on('data', (chunk) => { data += chunk; });
    stdin.on('end', () => resolve(data.trim()));
  });
}

function runGemini(query, model, outputFormat) {
  return new Promise((resolve, reject) => {
    const prompt = `${SEARCH_SYSTEM_PROMPT}\n\n---\n\nUser query: ${query}`;

    const args = [
      '-m', model,
      '--output-format', outputFormat,
      '--prompt', prompt,
    ];

    const timeout = Number(process.env.GEMINI_SEARCH_TIMEOUT) || TIMEOUT_MS;

    execFile('gemini', args, { timeout, maxBuffer: MAX_BUFFER }, (error, out, err) => {
      if (error) {
        const msg = err?.trim() || error.message || 'Gemini CLI execution failed';
        reject(new Error(msg));
        return;
      }
      resolve(out);
    });
  });
}

function aggregateStats(stats) {
  // Gemini CLI stats shape: { models: { <modelName>: { api: { totalLatencyMs }, tokens: { total, input, candidates } } } }
  const models = stats?.models;
  if (!models || typeof models !== 'object') return null;

  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalLatencyMs = 0;
  const modelNames = [];

  for (const [name, info] of Object.entries(models)) {
    modelNames.push(name);
    const tokens = info?.tokens || {};
    const api = info?.api || {};
    totalTokens += Number(tokens.total) || 0;
    inputTokens += Number(tokens.input) || 0;
    outputTokens += Number(tokens.candidates) || 0;
    totalLatencyMs += Number(api.totalLatencyMs) || 0;
  }

  if (totalTokens === 0 && totalLatencyMs === 0) return null;

  return { totalTokens, inputTokens, outputTokens, totalLatencyMs, modelNames };
}

function formatLatency(ms) {
  if (!ms) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatResponse(jsonStr) {
  try {
    const data = JSON.parse(jsonStr);

    if (data.error) {
      return `**Error:** ${data.error}\n`;
    }

    const response = data.response || '';
    let output = response;

    // Append stats footer if available
    const agg = aggregateStats(data.stats);
    if (agg) {
      output += '\n\n---\n';
      const parts = [];
      if (agg.modelNames.length) parts.push(`Model: ${agg.modelNames.join(', ')}`);
      if (agg.totalTokens) parts.push(`Tokens: ${agg.totalTokens.toLocaleString()}`);
      if (agg.inputTokens) parts.push(`In: ${agg.inputTokens.toLocaleString()}`);
      if (agg.outputTokens) parts.push(`Out: ${agg.outputTokens.toLocaleString()}`);
      if (agg.totalLatencyMs) parts.push(`Latency: ${formatLatency(agg.totalLatencyMs)}`);
      output += `*${parts.join(' | ')}*`;
    }

    return output;
  } catch {
    // If JSON parsing fails, return the raw output
    return jsonStr;
  }
}

async function main() {
  const userArgs = argv.slice(2);
  const opts = parseArgs(userArgs);

  if (opts.help) {
    printHelp();
    exit(0);
  }

  // Override model from env
  if (process.env.GEMINI_SEARCH_MODEL && opts.model === DEFAULT_MODEL) {
    opts.model = process.env.GEMINI_SEARCH_MODEL;
  }

  // Get query
  let query = opts.query;
  if (opts.fromStdin || (!query && !stdin.isTTY)) {
    query = await readStdin();
  }

  if (!query) {
    stderr.write('Error: No search query provided. Use --help for usage.\n');
    exit(1);
  }

  const outputFormat = opts.stream ? 'stream-json' : 'json';

  try {
    const result = await runGemini(query, opts.model, outputFormat);

    if (opts.raw || opts.stream) {
      stdout.write(result);
    } else {
      stdout.write(formatResponse(result));
    }
    stdout.write('\n');
  } catch (err) {
    stderr.write(`Error: ${err.message}\n`);
    exit(1);
  }
}

main();
