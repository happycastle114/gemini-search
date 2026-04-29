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
│   └── plugin.json          # Plugin manifest
├── bin/
│   └── gemini-search.mjs    # CLI wrapper (added to PATH)
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
