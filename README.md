# fcc — Flowchart for Claude Code

After every Claude Code task that changes code, fcc prints a link to a local
page that tells you **what changed without making you read the code**:

- **Story** — a headline, what the behavior was before and is now, each thing
  you asked for marked done / partial / missing, and a short list of **what
  to verify** (unhandled errors, changes nobody asked for, files changed
  outside Claude's edit tools, missing tests…).
- **Behavior flow** — a flowchart of what happens at runtime, in domain
  language, new / changed / removed steps highlighted. Every step is anchored
  to the real functions that implement it; links not backed by a call in the
  code are shown as "inferred".
- **Structure** — the symbol graph (functions, methods, classes added,
  modified or removed, the calls between them, their callers as context) and,
  one click further, the diff of each symbol.
- **History** — the development history of the project: every task is also
  written to `docs/flow/` in your repo (a Markdown file with the *why* —
  goal, decisions, rejected alternatives — the story and a Mermaid flowchart,
  plus a JSON sidecar). Commit it with the code it explains. The History tab
  shows the timeline grouped by feature or commit, tells you which tasks were
  committed, partly committed or discarded, and searches everything.

```
fcc: flowchart of 5 files → http://127.0.0.1:47291/?t=…#/shop-app-1a2b3c4d/20260922-154414-1187
```

- Works on any git repo; TypeScript/JavaScript get symbol-level graphs, other
  files appear as file nodes with their diff.
- Hooks add ~0.1 s per turn; the analysis runs in the background: the
  structure is ready in seconds, the story in about a minute.
- The story is written by Sonnet through your existing Claude Code login
  (`claude -p` with a minimal context: about $0.06 per task in our tests).
- Nothing is written into your repo. State lives in `~/.claude/flow/`.
- The viewer listens on 127.0.0.1 only and requires a random per-run token.

## Try it

```bash
claude --plugin-dir /path/to/fcc
```

Then ask Claude to change some code. When it finishes, open the printed link.

In Claude Code:

| Command | Effect |
|---|---|
| `/flow` | open the history of the current project |
| `/flow start "Discount codes"` | group the next tasks under a feature |
| `/flow end` | stop grouping |
| `/flow private` | keep this session's tasks out of the repo (the last one is withdrawn) |
| `/flow public` | write them to the repo again |

The story of a task is written from the whole conversation that led to it,
not just the last message: after a long discussion ending in "ok, go", the
*why* still contains the decisions you agreed on. Your raw messages stay on
your machine; only the summary goes into the repo.

## How it works

`UserPromptSubmit` snapshots the work tree as a git tree object (without
touching your index), `PostToolUse` records which files Claude edited, and
`Stop` snapshots again, then analyzes the two trees with ts-morph and asks the
model for the story, validating every reference it makes against the graph. See
[docs/DESIGN.md](docs/DESIGN.md).

## Development

```bash
npm install
npm test          # fixture repos + end-to-end hook tests
npm run typecheck
npm run build     # bundles dist/ (commit it: plugins install without npm)
```

Sources run directly on Node ≥ 22.18 (`node bin/fcc.ts …`); the bundle runs on
Node ≥ 18. Useful environment variables: `FCC_LLM` (`claude` default, `api`
to use the Anthropic API via the SDK, `off`), `FCC_MODEL` (`sonnet` default,
`haiku`, `opus` or a model id), `FCC_HOME` (state dir), `FCC_PORT`,
`FCC_HISTORY_DIR` (default `docs/flow`), `FCC_IDLE_MINUTES` (server auto-shutdown, default 30), `FCC_SYNC=1` (analyze
inside the Stop hook), `FCC_NO_SERVER=1`.

Errors from hooks and background processes go to `~/.claude/flow/fcc.log`;
hooks never fail the Claude Code session.
