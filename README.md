# @happycastle/gemini-search

Web search plugin for [Claude Code](https://code.claude.com) powered by [Gemini CLI](https://github.com/google-gemini/gemini-cli). Google Search grounding with structured JSON output, **mandatory source citations**, and **privacy-hardened by default**.

## Architecture

```
┌──────────────────────────────────────────────────┐
│                  Claude Code                      │
│                                                   │
│  /search "query"  ──►  skills/web-search/SKILL.md │
│  /research "topic" ──► skills/research/SKILL.md   │
│                                                   │
│         ▼                                         │
│  ┌─────────────────────────┐                      │
│  │  bin/gemini-search.mjs  │ ◄── Added to PATH    │
│  │                         │                      │
│  │  • Search-optimized     │                      │
│  │    system prompt        │                      │
│  │  • Mandatory citations  │                      │
│  │  • Privacy auto-disable │                      │
│  └───────────┬─────────────┘                      │
└──────────────┼───────────────────────────────────-┘
               ▼
┌──────────────────────────┐
│       Gemini CLI         │
│  --output-format json    │
│  --prompt "..."          │
│                          │
│  google_web_search ──►   │
│  Grounded response       │
└──────────────────────────┘
```

## Install

### Prerequisites

Install and authenticate [Gemini CLI](https://github.com/google-gemini/gemini-cli):

```bash
npm install -g @google/gemini-cli
gemini  # authenticate on first run
```

### As a Claude Code plugin (recommended)

Inside Claude Code, add this repo as a marketplace and install the plugin:

```text
/plugin marketplace add happycastle114/gemini-search
/plugin install gemini-search@happycastle-gemini
```

That's it. `/search`, `/research`, and the `web-search` / `research` skills are now available.

To update later:

```text
/plugin marketplace update happycastle-gemini
```

### Alternative: install from a local clone

```bash
git clone https://github.com/happycastle114/gemini-search.git
```

Then in Claude Code:

```text
/plugin marketplace add ./gemini-search
/plugin install gemini-search@happycastle-gemini
```

### Alternative: standalone CLI via npm

If you only want the `gemini-search` binary (no Claude Code plugin):

```bash
npm install -g @happycastle/gemini-search
gemini-search "latest Node.js LTS version"
```

> Note: `claude plugin install @happycastle/gemini-search` does **not** work — Claude Code plugins are distributed via marketplace catalogs (`.claude-plugin/marketplace.json`), not npm package names. Use the marketplace flow above.

## Usage

### Slash Commands

Once installed, Claude Code gains two slash commands:

| Command | Description |
|---------|-------------|
| `/search <query>` | Quick web search with citations |
| `/research <topic>` | Multi-step deep research workflow |

### Skills (Auto-triggered)

The plugin includes two skills that Claude Code activates automatically:

- **web-search** — Triggers on "search the web", "look up", "find online", "what's the latest", "current version of"
- **research** — Triggers on "research", "deep dive", "investigate thoroughly", "comprehensive analysis"

### MCP Tool (Native model invocation)

Installing this plugin **auto-registers a Model Context Protocol (MCP) server** so the model can invoke web search natively, the same way it would call a built-in tool. No `.mcp.json` editing required — the plugin's `plugin.json` declares the server and Claude Code wires it up on `/plugin install`.

| Tool name | When the model uses it |
|-----------|----------------------|
| `gemini_web_search` | Auto-invoked whenever the model needs current/real-world info: latest versions, recent news, live docs, evolving best practices, anything that may have changed since training cutoff. |

The tool returns the same citation-validated markdown the CLI does (`[Source](URL)` inline + `## Sources` block, byte-identical to grounding URLs, set-equality enforced). Set `raw: true` in the tool arguments to get the raw Gemini JSON envelope instead.

> The MCP server is the same `gemini-search` pipeline (privacy override, anti-hallucination citation contract, tool-invocation evidence gating) — just exposed over [stdio JSON-RPC](https://modelcontextprotocol.io) so the model's tool router can call it directly.

You can also wire the MCP server into another MCP-aware client (Cursor, Windsurf, raw Claude Desktop, etc.) by pointing it at the bundled binary:

```jsonc
{
  "mcpServers": {
    "gemini-search": {
      // -p installs the package, --package selects which bin to run.
      // (npx 's first positional arg becomes argv[0] of the chosen bin,
      //  not a bin name — so a multi-bin package needs --package + the
      //  bin name passed via the dedicated runner syntax below.)
      "command": "npx",
      "args": ["-y", "--package=@happycastle/gemini-search", "gemini-search-mcp"]
    }
  }
}
```

Or, if you have it installed globally (`npm i -g @happycastle/gemini-search`):

```jsonc
{
  "mcpServers": {
    "gemini-search": { "command": "gemini-search-mcp" }
  }
}
```

### CLI (Direct)

The `gemini-search` binary is added to PATH during Claude Code sessions:

```bash
# Basic search
gemini-search "latest Node.js LTS version"

# Raw JSON output (for scripting)
gemini-search --raw "TypeScript 6 release date" | jq '.response'

# Streaming JSONL
gemini-search --stream "comprehensive AI framework comparison"

# Stdin
echo "npm security advisories 2026" | gemini-search --stdin
```

The model is intentionally **not exposed as a flag**. Gemini CLI's own model routing (controlled by your `~/.gemini/settings.json`, account tier, and built-in `web-search` alias) picks the right model for the query. This keeps the wrapper future-proof against Google's model lineup changes.

## Configuration

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `GEMINI_SEARCH_TIMEOUT` | Request timeout (ms) | `600000` (10 min) |
| `GEMINI_SEARCH_MAX_BUFFER` | Max stdout buffer in bytes for non-stream modes | `52428800` (50 MB) |

To pin a specific model, set it in `~/.gemini/settings.json` under the `model.name` key — see the [Gemini CLI configuration reference](https://geminicli.com/docs/reference/configuration/).

## Privacy

`gemini-search` is privacy-hardened by default. **Every invocation auto-disables Gemini CLI usage statistics** without modifying your global `~/.gemini/settings.json`.

### How it works

On every call, the wrapper:

1. Writes a temporary system-override settings file to `$TMPDIR/gemini-search-priv-XXXX/system.json` containing `{ "privacy": { "usageStatisticsEnabled": false } }`.
2. Sets `GEMINI_CLI_SYSTEM_SETTINGS_PATH` to point Gemini CLI at this file. System overrides take precedence over user/project settings ([Gemini CLI docs](https://geminicli.com/docs/reference/configuration/#configuration-layers)).
3. Deletes the temp directory after the request completes.

The wrapper does not modify your `~/.gemini/settings.json` or OAuth credentials. Gemini CLI itself may still read or update its own runtime files such as auth tokens, session history, project registry, or installation metadata — those are managed by `gemini`, not by this wrapper.

### What this disables

- Gemini CLI usage statistics controlled by [`privacy.usageStatisticsEnabled`](https://geminicli.com/docs/reference/configuration/#privacy).

### What this does NOT disable

This wrapper does not change your Google account tier, API billing tier, Workspace/Code Assist license, or Vertex AI data-processing terms. **Account-tier model-training behavior is separate from this CLI usage-statistics setting.**

| Auth method | Prompts used to train Google models? | Source |
|-------------|--------------------------------------|--------|
| Personal Google account (free OAuth) | **Yes**, under the free-tier terms | [Gemini CLI Terms & Privacy](https://geminicli.com/docs/resources/tos-privacy/) |
| Gemini API key (free tier) | **Yes**, under Gemini API free-tier terms | [Gemini API Terms](https://ai.google.dev/gemini-api/terms) |
| Gemini API key (paid tier) | **No** | [Gemini API Terms](https://ai.google.dev/gemini-api/terms) |
| Google Workspace / Code Assist licensed | **No** | [Code Assist Privacy](https://developers.google.com/gemini-code-assist/resources/privacy-notice-gemini-code-assist-individuals) |
| Vertex AI (`GOOGLE_GENAI_USE_VERTEXAI=true`) | **No** | [Vertex AI Data Governance](https://cloud.google.com/vertex-ai/generative-ai/docs/data-governance) |

If you need a hard guarantee that your prompts are not used for model training, use **Vertex AI** or a **paid Gemini API key**. Setting `usageStatisticsEnabled: false` (which this wrapper does automatically) is **not** in itself a training opt-out on the free OAuth or free Gemini API tier — verify against the live Google docs above before treating it as such.

## Plugin Structure

```
gemini-search/
├── .claude-plugin/
│   ├── plugin.json          # Plugin manifest (auto-registers MCP server)
│   └── marketplace.json     # Marketplace catalog
├── bin/
│   ├── gemini-search.mjs        # CLI wrapper (added to PATH)
│   └── gemini-search-mcp.mjs    # Stdio MCP server (gemini_web_search tool)
├── skills/
│   ├── web-search/
│   │   └── SKILL.md         # Web search skill
│   └── research/
│       └── SKILL.md         # Deep research skill
├── commands/
│   ├── search.md            # /search slash command
│   └── research.md          # /research slash command
├── hooks/
│   └── hooks.json           # Lifecycle hooks
├── .github/
│   └── workflows/
│       ├── ci.yml           # Validation CI
│       └── publish.yml      # npm + GitHub release
├── .releaserc.json          # semantic-release config
├── package.json
├── LICENSE                  # MIT
└── README.md
```

## How It Works

1. **Privacy override** — A per-invocation system-override settings file disables `privacy.usageStatisticsEnabled` without touching your global config or auth.
2. **System prompt + JSON-encoded query** — `gemini-search` wraps every query with a search-optimized prompt that forces Gemini to use `google_web_search` and **mandates inline `[Source](url)` citations** for every claim. The user query is embedded as a JSON-encoded string (`JSON.stringify(query)`), so any quotes, backticks, angle-brackets, or pseudo-tags inside the query cannot escape the prompt boundary and inject new instructions.
3. **JSON parsing + raw validation** — Uses `--output-format json` to get structured responses with token stats and grounding metadata. Malformed JSON, `data.error` payloads, empty responses, and missing citations are all rejected with a non-zero exit. `--raw` validates identically before emitting the raw envelope.
4. **Citation enforcement** — The wrapper validates that the rendered markdown contains at least one literal inline `[Source](url)` link **with a valid http(s) URL outside of code blocks** AND a `## Sources` heading on its own line. Image syntax `![Source](url)` and citations inside fenced/inline code spans do not count. Responses without both real citations and the heading are rejected. The wrapper never synthesizes citations on its own.
5. **True streaming** — `--stream` uses `spawn()` and pipes Gemini's `stream-json` output through stdout/stderr live, with no buffer cap. Downstream `EPIPE` (e.g. `... | head -3`) is treated as a clean exit.
6. **No model flag** — Gemini CLI's built-in routing picks the right model. Override via `~/.gemini/settings.json` if needed.
7. **Cleanup-safe** — Signal handlers are registered before the temp dir is created. On `SIGINT`/`SIGTERM` the wrapper kills the active `gemini` child (with a `SIGKILL` fallback after a short grace window so it never orphans), removes the temp privacy-override directory, and re-raises the signal so the parent shell sees the correct exit status.

## Citation Contract & Provenance Limits

The wrapper enforces a strict citation contract on every non-`NO_RESULTS` response and rejects with a non-zero exit otherwise:

| Check | Rule |
|-------|------|
| `## Sources` heading | Required, on its own line, exactly `## Sources` |
| Inline citations | ≥1 `[Source](https://…)` outside fenced/inline code spans and HTML |
| Forbidden hosts | `example.com`/`.org`/`.net`, `foo.com`, `bar.com`, `your-source.com` — **including all subdomains** (`www.example.com`, `docs.api.example.org`, …) |
| Forbidden URL tokens | URL substring match (case-insensitive): `...`, `TODO`, `PLACEHOLDER`, `your-source` |
| Inline ↔ Sources mapping | **Set equality** — every inline URL must appear in `## Sources` AND every `## Sources` URL must appear inline (no extras either direction) |
| URL comparison | **Byte-identical** after trimming trailing `.,;:!?)]` punctuation only — **no case folding** (RFC 3986 §3.3 paths are case-sensitive) |
| `## Sources` placement | Must be the **final** content block — no prose or headings may follow |
| `google_web_search` invocation | The Gemini CLI `stats.tools.byName.google_web_search.success` counter MUST be ≥ 1 (cited responses without a successful search call are rejected; `NO_RESULTS` without a search call is also rejected) |

**Provenance limit (honest disclosure):** Gemini CLI's `--output-format json` stats expose only the *count* of `google_web_search` invocations, **not the URL set returned by the grounding tool**. The wrapper can therefore prove that a web search was actually attempted and succeeded in this run, but it **cannot** cross-check that each cited URL came from that grounding result set. The system prompt instructs the model to never invent or paraphrase URLs, and the structural / placeholder / set-equality checks above catch the most common fabrication failure modes — but a malicious or buggy model that returns *real-looking but non-grounded* URLs from training data would still pass validation. Treat the citation contract as a high-quality structural filter, not a cryptographic provenance guarantee.

## Development

```bash
git clone https://github.com/happycastle114/gemini-search.git
cd gemini-search

# Validate
node --check bin/gemini-search.mjs
node -e "JSON.parse(require('fs').readFileSync('.claude-plugin/plugin.json', 'utf8'))"

# Test locally with Claude Code
claude --plugin-dir .
```

## Release

Releases are automated via [semantic-release](https://semantic-release.gitbook.io/) on push to `master`/`main`.

Uses [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add new search model option        → minor bump
fix: handle empty search results          → patch bump
feat!: redesign search output format      → major bump
```

## License

MIT
