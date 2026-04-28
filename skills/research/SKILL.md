---
description: Deep research workflow using multiple Gemini web searches. Use for comprehensive analysis requiring multiple sources, comparisons, or multi-step investigation. Triggers on "research", "deep dive", "investigate thoroughly", "comprehensive analysis", "compare and contrast".
---

# Deep Research Workflow

Multi-step research methodology using sequential Gemini web searches. Each step builds on previous findings to produce thorough, well-cited analysis.

## Research Protocol

### Step 1: Initial Survey
Run a broad search to map the landscape:
```bash
gemini-search "Overview of [topic] — key players, recent developments, current state"
```

### Step 2: Targeted Deep Dives
Based on initial findings, run focused queries for each important aspect:
```bash
gemini-search "[specific aspect 1] detailed analysis and benchmarks"
gemini-search "[specific aspect 2] comparison with alternatives"
gemini-search "[specific aspect 3] known limitations and caveats"
```

### Step 3: Verification & Counter-arguments
Search for opposing viewpoints and potential issues:
```bash
gemini-search "[topic] criticisms, limitations, and known problems"
gemini-search "[topic] vs [alternative] — which is better and why"
```

### Step 4: Synthesis
Combine all findings into a structured report with:
- Executive summary (2-3 sentences)
- Key findings with citations
- Comparison table (if applicable)
- Recommendations
- Sources list

## Research Templates

### Technology Evaluation
```bash
# 1. Overview
gemini-search "What is [technology]? Current version, maturity, adoption"

# 2. Technical depth
gemini-search "[technology] architecture, performance benchmarks 2025"

# 3. Ecosystem
gemini-search "[technology] ecosystem — libraries, tools, community size"

# 4. Trade-offs
gemini-search "[technology] vs [alternatives] — pros, cons, migration cost"

# 5. Production readiness
gemini-search "[technology] production usage — who uses it, known issues, scaling"
```

### Security Research
```bash
# 1. Vulnerability scan
gemini-search "[package/service] security vulnerabilities CVE 2024 2025"

# 2. Best practices
gemini-search "[package/service] security hardening best practices"

# 3. Incident history
gemini-search "[package/service] security incidents and post-mortems"
```

### API/Library Research
```bash
# 1. Official docs
gemini-search "[library] official documentation API reference"

# 2. Usage patterns
gemini-search "[library] real-world usage examples GitHub production"

# 3. Migration guides
gemini-search "[library] migration guide from [old version] to [new version]"

# 4. Known issues
gemini-search "[library] known issues workarounds GitHub issues"
```

## Advanced: Streaming for Long Research

For queries that may take longer, use streaming mode to see progress live:
```bash
gemini-search --stream "comprehensive analysis of [complex topic]"
```

This pipes Gemini's `stream-json` output through stdout in real time (no buffering, no buffer cap), so you can see when Gemini is searching and when it's synthesizing.

## Model Routing & Privacy

`gemini-search` does not expose a model flag — Gemini CLI's own routing picks the model. Pin one in `~/.gemini/settings.json` under `model.name` if needed.

Every invocation auto-disables `privacy.usageStatisticsEnabled` via a temporary system-override settings file; your global config and OAuth credentials are not modified. See the project README "Privacy" section for the auth-tier truth table.

## Output Format

Always structure final research output as:

```markdown
## Research: [Topic]

### Summary
[2-3 sentence executive summary]

### Key Findings
1. **Finding 1** — [detail] [Source](url)
2. **Finding 2** — [detail] [Source](url)
3. **Finding 3** — [detail] [Source](url)

### Comparison (if applicable)
| Aspect | Option A | Option B |
|--------|----------|----------|
| ...    | ...      | ...      |

### Recommendations
- [Actionable recommendation 1]
- [Actionable recommendation 2]

## Sources
- [Source 1](url) — [brief description]
- [Source 2](url) — [brief description]
```
