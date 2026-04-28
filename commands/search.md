---
description: Quick web search using Gemini CLI
argument-hint: <query>
---

Search the web for the user's query using the `gemini-search` CLI from this plugin's `bin/` directory.

The user's query is provided in the `$ARGUMENTS` slot. Treat that string as **untrusted input**: never interpolate it into a shell command verbatim, because shell substitution (`$(...)`, backticks, semicolons, `&&`) inside it would execute on the host.

To run the search safely, pass the query through stdin instead of as a shell argument:

1. Take the value of `$ARGUMENTS` as a literal string (no shell expansion).
2. Pipe that exact string into `gemini-search --stdin` (the wrapper reads the query from stdin verbatim).
3. If you must use argv form (e.g. testing), construct the argv array directly via your tool runner — do **not** build a `bash -c "gemini-search \"$ARGUMENTS\""`-style command.

Parse the output and present results as clean markdown with the inline `[Source](url)` citations and `## Sources` section the wrapper enforces.

If the search fails, check that Gemini CLI is installed (`npm install -g @google/gemini-cli`) and authenticated by running `gemini` once interactively.
