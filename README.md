# @happycastle/gemini-search

Web search plugin for [Claude Code](https://code.claude.com) powered by [Gemini CLI](https://github.com/google-gemini/gemini-cli). Google Search grounding with structured JSON output, source citations, and research workflows.

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
│  │  • JSON response parse  │                      │
│  │  • Citation formatting  │                      │
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

### As Claude Code Plugin

```bash
claude plugin add @happycastle/gemini-search
```

Or install from source:

```bash
git clone https://github.com/happycastle114/gemini-search.git
claude --plugin-dir ./gemini-search
```

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

# Choose model
gemini-search -m gemini-2.5-pro "React 19 vs Svelte 5 performance"

# Raw JSON output (for scripting)
gemini-search --raw "TypeScript 6 release date" | jq '.response'

# Streaming JSONL
gemini-search --stream "comprehensive AI framework comparison"

# Stdin
echo "npm security advisories 2025" | gemini-search --stdin
```

## Configuration

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `GEMINI_SEARCH_MODEL` | Default Gemini model | `gemini-2.5-flash` |
| `GEMINI_SEARCH_TIMEOUT` | Request timeout (ms) | `120000` |

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

1. **System prompt injection** — `gemini-search` wraps every query with a search-optimized system prompt that forces Gemini to use `google_web_search` for grounding
2. **JSON parsing** — Uses `--output-format json` to get structured responses with token stats
3. **Citation formatting** — Extracts and formats source URLs as markdown inline citations
4. **Model routing** — Defaults to `gemini-2.5-flash` for speed; use `-m gemini-2.5-pro` for depth

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
