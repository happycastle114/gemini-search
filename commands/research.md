---
description: Deep multi-step research on a topic using Gemini web search
argument-hint: <topic>
---

Conduct deep research on the topic provided in `$ARGUMENTS` using the research workflow from the `/gemini-search:research` skill.

The user's topic in `$ARGUMENTS` is **untrusted input**. Never interpolate it directly into a shell command — shell substitution (`$(...)`, backticks, semicolons, `&&`) inside the topic would execute on the host. Always pass the topic to `gemini-search` through stdin (`gemini-search --stdin`) or via your tool runner's argv array, never via `bash -c` string concatenation.

Follow this protocol:

1. **Initial survey** — Run `gemini-search --stdin` with the literal string `Overview of <topic>` piped to stdin to map the landscape.
2. **Targeted dives** — Based on findings, run 2-3 focused follow-up searches on key aspects (each via `gemini-search --stdin`).
3. **Verification** — Search for counter-arguments and limitations.
4. **Synthesis** — Combine into a structured report with citations.

Use `gemini-search` from this plugin's `bin/` directory for each query. The wrapper enforces inline `[Source](url)` citations and a `## Sources` heading; preserve those in your synthesis.

Present the final output as a structured research report with:
- Executive summary
- Key findings with inline citations
- Comparison table (if applicable)
- Recommendations
- Full source list under a `## Sources` heading
