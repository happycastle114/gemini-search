---
description: Quick web search using Gemini CLI
argument-hint: <query>
---

Search the web for "$ARGUMENTS" using Gemini CLI with Google Search grounding.

Use the `gemini-search` command from this plugin's `bin/` directory:

```bash
gemini-search "$ARGUMENTS"
```

Parse the output and present results as clean markdown with source citations.
If the search fails, check that Gemini CLI is installed (`npm install -g @google/gemini-cli`) and authenticated.
