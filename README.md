# fcc — Flowchart for Claude Code

After every Claude Code task that changes code, fcc prints a link to a local
page that tells you **what changed without making you read the code**:

- **Story** — a headline, the *why* behind the task (goal, decisions, rejected
  alternatives), what the behavior was before and is now, each thing you asked
  for marked done / partial / missing, and a short list of **what to verify**
  (unhandled errors, changes nobody asked for, files changed outside Claude's
  edit tools, missing tests…).
- **Behavior flow** — a flowchart of what happens at runtime, in domain
  language, new / changed / removed steps highlighted. Every step is anchored
  to the real functions that implement it; links not backed by a call in the
  code are shown as "inferred".
- **Structure** — the symbol graph (functions, methods, classes added,
  modified or removed, the calls between them, their callers as context) and,
  one click further, the diff of each symbol.
- **History** — the development history of the project: every task is also
  written to `docs/flow/` in your repo, as Markdown (the *why*, the story and
  a Mermaid flowchart, readable on GitHub and in your IDE) plus a JSON
  sidecar. Commit it with the code it explains. The History tab shows the
  timeline grouped by feature or commit, tells you which tasks were committed,
  partly committed or discarded, and searches everything.

```
fcc: flowchart of 5 files → http://127.0.0.1:47291/?t=…#/shop-app-1a2b3c4d/20260922-154414-1187
```

## Install

Requires [Claude Code](https://code.claude.com) and Node ≥ 18. No `npm
install`: the plugin ships its own bundle.

```bash
claude plugin marketplace add <your-github-user>/fcc
```

```bash
claude plugin install fcc@fcc
```

The install prompts for a scope: `user` makes it available in every project
(terminal and desktop app), `local` limits it to the current one. To try it
without installing, run `claude --plugin-dir /path/to/fcc` from a checkout.

Then ask Claude to change some code and open the link it prints when it
finishes. To update later: `claude plugin update fcc@fcc`; to remove it:
`claude plugin uninstall fcc@fcc`.

## Commands

| Command | Effect |
|---|---|
| `/flow` | open the history of the current project |
| `/flow start "Discount codes"` | group the next tasks under a feature |
| `/flow end` | stop grouping |
| `/flow drop` | delete the last task's report so it is never committed |
| `/flow private` | keep this session's tasks out of the repo (the last one is withdrawn) |
| `/flow public` | write them to the repo again |

## Good to know

- Works on any git repository; outside one it stays silent. TypeScript and
  JavaScript get symbol-level graphs, other files appear as file nodes with
  their diff.
- Hooks add ~0.1 s per turn; the analysis runs in the background: the
  structure is ready in seconds, the story in about a minute.
- The story is written by Sonnet through your existing Claude Code login
  (`claude -p` with a minimal context: about $0.06 per task in our tests).
  `FCC_LLM=off` turns it off, `FCC_LLM=api` uses the Anthropic API instead.
- **What you type is never stored.** The conversation behind a task is read
  from the Claude Code transcript, used to write the story, then dropped — it
  reaches neither the repo nor fcc's own cache, and tasks are listed by their
  headline, never by your prompt. The only thing fcc writes in your repo is
  the history record in `docs/flow/`, which you commit yourself; everything
  else lives in `~/.claude/flow/`.
- A report you do not want is easy to get rid of: `/flow drop`, or the
  **Remove from repo** button in the task panel (**Delete this task** also
  clears what fcc kept locally). A dropped task is marked private, so a later
  re-analysis does not write it back.
- The viewer listens on 127.0.0.1 only and requires a random per-run token.

## How it works

`UserPromptSubmit` snapshots the work tree as a git tree object (without
touching your index), `PostToolUse` records which files Claude edited, and
`Stop` snapshots again, then analyzes the two trees with ts-morph and asks the
model for the story, validating every reference it makes against the graph.
Tasks are matched to commits by content, so the link survives squash and
rebase. See [docs/DESIGN.md](docs/DESIGN.md) for the decisions behind all of
this, and `docs/flow/` for fcc's own history.

## Development

```bash
npm install
npm test          # fixture repos + end-to-end hook tests
npm run typecheck
npm run build     # bundles dist/ (commit it: plugins install without npm)
```

Sources run directly on Node ≥ 22.18 (`node bin/fcc.ts …`); the bundle runs on
Node ≥ 18. Environment variables: `FCC_LLM` (`claude` default, `api`, `off`),
`FCC_MODEL` (`sonnet` default, `haiku`, `opus` or a model id), `FCC_HOME`
(state dir), `FCC_HISTORY_DIR` (default `docs/flow`), `FCC_PORT`,
`FCC_IDLE_MINUTES` (viewer auto-shutdown, default 30), `FCC_SYNC=1` (analyze
inside the Stop hook), `FCC_NO_SERVER=1`.

Errors from hooks and background processes go to `~/.claude/flow/fcc.log`;
hooks never fail the Claude Code session.

## License

MIT — see [LICENSE](LICENSE).
