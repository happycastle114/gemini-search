---
description: Search the web for current information using Gemini CLI with Google Search grounding. Use when you need real-time data, latest documentation, current events, or to verify claims against live sources. Triggers on "search the web", "look up", "find online", "what's the latest", "current version of", "recent news about".
---

# Web Search via Gemini CLI

Search the web using Google's Gemini CLI with built-in Google Search grounding. Returns accurate, cited results with source URLs.

## Prerequisites

Install Gemini CLI globally:
```bash
npm install -g @google/gemini-cli
```

Authenticate once:
```bash
gemini
```

## Quick Usage

Run the bundled `gemini-search` script from this plugin's `bin/` directory:

```bash
gemini-search "your search query"
```

The script automatically:
1. Wraps your query with a search-optimized system prompt
2. Forces Gemini to use `google_web_search` for grounding
3. Parses the JSON response and formats clean markdown with citations

## Direct Gemini CLI Usage

If you prefer calling Gemini CLI directly:

```bash
gemini --output-format json --prompt "Search the web: What is the latest stable version of React?"
```

### Parse the JSON response

The `--output-format json` flag returns:
```json
{
  "session_id": "...",
  "response": "The latest stable version of React is 19.1...",
  "stats": {
    "totalTokens": 1234,
    "inputTokens": 100,
    "outputTokens": 1134,
    "totalDuration": "3.2s"
  }
}
```

Extract just the response text:
```bash
gemini --output-format json --prompt "query" | jq -r '.response'
```

## Search Prompt Patterns

### Fact Lookup
```
Search the web for the current LTS version of Node.js.
Include the release date and end-of-life date.
Cite your sources.
```

### Comparison Research
```
Search the web and compare Bun vs Deno runtime performance benchmarks from 2025.
Include specific numbers and link to the benchmark sources.
```

### Documentation Lookup
```
Search for the official documentation on React Server Components streaming.
Find the API reference page and summarize the key props and usage patterns.
```

### Security Advisory Check
```
Search for recent security advisories for the 'express' npm package.
List CVE numbers, severity, and affected versions.
```

### API/Library Version Check
```
Search for the latest version of @anthropic-ai/sdk and list breaking changes
from the previous major version. Include migration guide links if available.
```

## Model Selection

| Model | Best For | Speed |
|-------|----------|-------|
| `gemini-2.5-flash` | Quick lookups, fact checks | Fast |
| `gemini-2.5-pro` | Deep research, comparisons | Slower |
| `gemini-3-flash-preview` | Latest capabilities | Fast |

Override the default model:
```bash
gemini-search -m gemini-2.5-pro "complex research query"
```

## Tips

- **Be specific** — "React 19 useActionState hook API" beats "React hooks"
- **Include time context** — "2025 Node.js performance benchmarks" gets recent results
- **Ask for sources** — The search prompt already forces citations, but being explicit helps
- **Chain searches** — Run multiple targeted queries rather than one broad query
- **Use --raw for scripting** — `gemini-search --raw "query" | jq '.response'` for pipelines
