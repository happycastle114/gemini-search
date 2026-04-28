---
description: Deep multi-step research on a topic using Gemini web search
argument-hint: <topic>
---

Conduct deep research on "$ARGUMENTS" using the research workflow from the `/gemini-search:research` skill.

Follow this protocol:

1. **Initial survey** — Run `gemini-search "Overview of $ARGUMENTS"` to map the landscape
2. **Targeted dives** — Based on findings, run 2-3 focused follow-up searches on key aspects
3. **Verification** — Search for counter-arguments and limitations
4. **Synthesis** — Combine into a structured report with citations

Use `gemini-search` from this plugin's `bin/` directory for each query.

Present the final output as a structured research report with:
- Executive summary
- Key findings with inline citations
- Comparison table (if applicable)
- Recommendations
- Full source list
