# fcc — how it works

fcc turns each Claude Code task into an explanation you can read instead of
the diff, and keeps that explanation in the repository. This document is for
someone changing fcc itself: what happens at each step, where the code is, and
what it cannot do.

## What it produces

A task is read top-down, and each level is only opened when the one above
raises a question:

| Level | Shows | Comes from |
|---|---|---|
| Story | Headline, the why (goal, decisions, rejected alternatives), before/after behavior, the asks marked done / partial / missing, and what to verify | the model |
| Behavior | Flowchart of the runtime behavior the task touched, in domain language, steps marked new / changed / removed | the model, **anchored** to the level below |
| Structure | Symbol graph: changed functions, methods and classes, the calls between them, 1-hop context | static analysis |
| Code | Per-symbol and per-file diffs | git |

Anchoring is what makes the top two levels trustworthy. Every behavior step
must cite symbols that exist in the graph — unknown ids are dropped — and
every link between steps is checked against the call graph; a link with no
supporting path is shown as "inferred". The list of things to verify matters
more than the diagram: reading less code only works if the tool says where
code *should* be read.

## The pipeline

```
UserPromptSubmit ─► snapshot work tree ─► ~/.claude/flow/sessions/<session>/current.json
PostToolUse      ─► append {tool, files} ─► …/tools.jsonl
Stop             ─► snapshot again; if Claude used tools and the tree changed:
                    write tasks/<id>/graph.json {status: pending}
                    spawn `fcc analyze` (detached):
                      static graph ─► graph.json {status: ready, narrative: pending}  (seconds)
                      story        ─► graph.json {narrative: ready | error}           (~1 min)
                      record       ─► <repo>/docs/flow/<yyyy-mm>/<task>.{md,json}
                    ensure `fcc serve` is running           ─► prints the link
browser          ─► http://127.0.0.1:<port>/?t=<token>#/<repo>/<task>
                    opens on the story; polls while anything is pending
```

Everything after the second snapshot happens in a detached process: the hooks
add about 0.1 s to a turn and never block Claude Code. The structure is
written as soon as it is ready so the page has something to show while the
model writes.

## Module map

```
bin/fcc.ts            CLI entry: hook | analyze | serve | open | flow
src/hooks.ts          the three hooks; decides whether a turn is a task at all
src/git.ts            snapshots, tree diffs, blob reads (all through git plumbing)
src/graph/            static analysis
  analyze.ts          orchestrates: changed files → symbols → edges → nodes
  symbols.ts          ts-morph: what a symbol is, and how calls resolve
  fingerprint.ts      content hashes used later to find a task's commits
  filters.ts          which files are code, which are excluded
src/narrative/        the story
  prompt.ts           what the model sees, and the JSON schema it must fill
  llm.ts              engines: headless Claude Code, or the Anthropic SDK
  validate.ts         maps refs back, drops invented ones, grades the links
src/history/          the repository history
  conversation.ts     the messages behind a task, read from the transcript
  record.ts           the Markdown + JSON written into the repo
  commits.ts          matching a task to the commits that contain it
  timeline.ts         the grouped, searchable history
  discard.ts          removing a report, or a whole task
src/server/           the local viewer server
src/web/              the page: app.js (shell, structure), story.js, history.js
src/config.ts         config files and environment overrides
```

## Snapshots

Both snapshots build a git tree object from a throwaway index
(`GIT_INDEX_FILE` + `git add -A` + `git write-tree`): tracked and untracked
files, `.gitignore` honored, and the real index, HEAD and stash left alone.
`git stash create` would have been shorter but ignores untracked files, so a
new file would never appear in a task.

The analysis then reads both trees straight from git objects. It is therefore
deterministic and immune to edits made after the turn ended — which matters,
because it runs while you are already typing the next prompt.

## Static analysis

Each version is loaded into an in-memory ts-morph project, with compiler
options taken from the root `tsconfig.base.json` or `tsconfig.json` so `paths`
aliases resolve.

- **Symbols** are top-level declarations and members of top-level classes.
  Anything nested belongs to its enclosing symbol, top-level side-effect
  statements pool into one `(module)` symbol per file, and imports never count
  as a change on their own. A symbol changed when its text differs between the
  two versions.
- **Edges** (call, new, render, reference) are collected for every changed
  symbol in both versions — outgoing by resolving call sites, incoming through
  find-references — then diffed: in both is unchanged, only after is added,
  only before is removed. That is how a call that disappeared can be drawn.
- **Context** is one hop: unchanged callers and callees of changed symbols,
  drawn grey, so a change is never shown floating on its own.
- **Clusters** are the nearest `package.json` or Nx `project.json`.
- **Attribution**: a changed file is Claude's when it was written through an
  edit tool, otherwise it is marked external (a shell command, you, another
  session) — a useful signal the model is told about.

Non-code files become plain file nodes with their diff; lockfiles, build
output and generated files are excluded.

## The story

The model receives the conversation that led to the task, the changed files
with their attribution, the changed symbols with their diffs, the context
symbols and the edges. Files and symbols are numbered (`f1`, `s2`…) rather
than passed by path, which keeps the input small and the schema's `enum`
short.

The answer is schema-constrained JSON (`--json-schema`, or
`output_config.format` on the API). Validation maps the numbers back to graph
ids, drops anything that does not exist, and grades each link between steps as
grounded or inferred by walking the call graph. A story that fails validation,
or an engine that errors, never hides the structure.

Two engines:

- **Headless Claude Code** (default): `claude -p` with our own system prompt
  and no tools, settings, plugins, MCP servers or skills, run in a temp
  directory with `FCC_DISABLE=1` so fcc's own hooks stay quiet inside it. It
  uses the login you already have. Stripping that default context is what
  brought a task from 54 s and $0.26 down to about 40 s and $0.06.
- **The Anthropic API** through the official SDK, for people who prefer a key.

The conversation comes from the Claude Code transcript: the user's messages
and the assistant's prose between the end of the previous task and the end of
this one. The assistant's side is needed because "ok, go" means nothing
without the proposal it accepts. Budgets: 4k characters per user message, 3k
per assistant message (10k for the last one, usually the plan being approved),
60k in total, trimming the oldest assistant text first. It is held in memory
only — `writeGraph` strips it — so nothing you typed is written to disk.

## The repository history

After the story, a record is written to
`<repo>/docs/flow/<yyyy-mm>/<task id>-<slug>.md` with a JSON sidecar. The
Markdown carries the why, the story, the asks, what to verify, a Mermaid
flowchart and the file list; the JSON carries the same plus the symbols and
the fingerprint. Diffs and the full graph stay in the local cache, since git
already has the code. The analysis ignores this directory, so a record written
while the next task is running never shows up as a change.

**Commits** are matched by content, not by id: the fingerprint hashes the
meaningful added and removed lines (short or punctuation-only lines are
ignored), and one `git log -p -U0` of the current branch is compared against
it. Above 80 % of lines found the task is "included", above 20 % "partial",
otherwise it is "not committed" if the lines are still in the work tree and
"discarded" if they are not. This survives squash, rebase and cherry-pick, and
is computed when the history is opened, never stored.

**Grouping** puts a task under its explicit feature if one was opened, else
under the commit that contains it, else under its session.

**Teammates' records** pulled from the repo appear in the timeline; opening
one rebuilds the story from the record alone, without diffs or call edges.

**Getting rid of one**: the viewer deletes the record (and optionally the
local task), and `/flow drop` does the same for the last task. A dropped task
is marked private, so re-analysis never writes it back.

## The viewer

A single Node process serves the page and a small JSON API on 127.0.0.1 only.
It requires a random per-run token, accepted in the URL, in a header, or in a
cookie it sets for the session; deletions accept the header alone, so no other
page in the browser can trigger one. It refuses requests whose `Host` is not
loopback, and it shuts down after 30 idle minutes.

The page is plain HTML and JavaScript with Cytoscape and ELK, no build step.
It polls while a task is still being analyzed, and the URL carries the task
and the view so a page can be shared as it is being read.

## Configuration

Settings merge from built-in defaults, `~/.claude/flow/config.json`,
`<repo>/.claude/flow.json`, and finally environment variables, which win and
say so when they do. The model and the engine are settable with `/flow model`;
the rest (`FCC_HOME`, `FCC_HISTORY_DIR`, `FCC_PORT`, `FCC_IDLE_MINUTES`,
`FCC_SYNC`, `FCC_NO_SERVER`) is environment-only for now.

## Packaging

`dist/` is an esbuild bundle targeting Node 18 and is committed, because
plugins are installed without `npm install` — and because hooks run with the
*project's* Node, which a version manager may pin below the version that runs
TypeScript natively. It is code-split so a hook starts in about 25 ms and
loads TypeScript only when analyzing. Rebuild it when releasing, not on every
commit, to keep the repository small.

## Measured

On a 2,100-file Nx monorepo: snapshot 0.12 s, `Stop` hook 0.11 s, static
analysis 2.5 s. On the small demo repository: analysis 0.1 s, story 36–45 s
and about $0.06 with Sonnet. Hook startup from the bundle: ~25 ms.

## What it cannot do

- An interrupted turn (no `Stop`) is dropped: the next prompt starts a new
  snapshot.
- A turn with no tool calls produces nothing, even if files changed — that
  would be you editing, not Claude.
- Resolution is repo-local: calls through values typed by `node_modules`
  packages, dependency injection, events and dynamic dispatch are not linked.
- Only the root tsconfig is read: no `extends`, no per-project tsconfigs.
- Symbol-level analysis is TypeScript and JavaScript only; other languages get
  file nodes, the story and the history.
- Snapshots add unreferenced blobs to the object store; `git gc` prunes them.
- Diffs above ~120k characters are shortened before the model sees them, so
  the story of a very large task is coarser.
- Commit matching looks at the current branch only, and very common lines
  (`return true;`) can inflate a match slightly.
- Tasks from before the plugin was installed are not reconstructed.
- Without a transcript the story is written from the diffs alone and the asks
  are left empty.
- Not yet: collapsing very large graphs, a Mermaid export of the structure
  graph, the full Nx project graph, and a config file for everything that is
  still environment-only.
