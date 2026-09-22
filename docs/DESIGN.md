# fcc — design

Flowchart for Claude Code: at the end of each Claude Code task, a visual,
plain-language account of what changed, so the developer can review the work
while reading less and less code.

This records the decisions taken in the design session (Q1–Q25), the
deviations found while building M1, the revision after prototype P1, and the
decisions on the development history (S1–S14).

## Goal and levels

The goal is to look at code less, not to look at code in a different shape.
The page is read top-down, and each level is only opened when the one above
raises a question:

| Level | Shows | Source |
|---|---|---|
| 0 · Story | Headline, before/after in domain terms, the request split into asks (done / partial / missing), and **what to verify** (risks, external changes, unrequested changes, missing tests) | LLM |
| 1 · Behavior | Flowchart of the runtime behavior the task touched, in domain language, steps marked new / changed / removed | LLM, **anchored** to level 2 |
| 2 · Structure | Symbol graph: changed functions/classes, calls between them, 1-hop context | Static analysis (M1) |
| 3 · Code | Per-symbol and per-file diffs | git |

Anchoring is what makes levels 0–1 trustworthy: every behavior step must cite
real symbols from level 2 (unknown ids are dropped), and every link between
steps is checked against the call graph; a link with no supporting path is
shown as "inferred". The "what to verify" list matters more than the diagram:
reading less code only works if the tool says where code *should* be read.

## Decisions

| # | Topic | Decision |
|---|---|---|
| Q1 | Purpose | Personal, immediate review of what Claude changed. Sharing (PRs) and history/audit come later. |
| Q2 | Unit of work | One turn: `UserPromptSubmit` → `Stop`. No diagram if the turn touched nothing. `/flow start … end` groups turns (M3). |
| Q3 | Change source | Git snapshots are the truth; Claude's tool calls (Edit/Write/MultiEdit/NotebookEdit) attribute files to Claude. |
| Q4 | Node granularity | **Revised after P1.** The primary view is behavior (level 1) in domain language; symbols (level 2) are the grounding and drill-down layer. |
| Q5 | Languages | TypeScript/JavaScript first (ts-morph), extractor behind an interface. |
| Q6 | Distribution | Claude Code plugin, open source, plugin layout from day one. |
| Q7 | Timing | Hooks never slow the session. See deviation D1. |
| Q8 | LLM | **Revised after P1.** Sonnet by default (Haiku missed an unimplemented ask and an unrequested change). `claude -p` with a minimal context (own system prompt, no tools, no settings, no MCP) so no API key is needed; the Anthropic API is an option; can be switched off. |
| Q9 | Viewing | Local server, the Stop hook prints the link (no auto-opening tabs). |
| Q10 | Context | Changed symbols + 1-hop neighbors (callers/callees) as grey context. Depth configurable (M3). |
| Q11 | Clusters | Nearest `package.json` / Nx `project.json`; full Nx project graph in M3. |
| Q12 | Non-code files | Opaque file nodes with their diff; lockfiles/build output/generated files excluded by default. |
| Q13 | No git | Plugin is inactive outside git repos. |
| Q14 | Rendering | Cytoscape.js + ELK layered layout, compound nodes, no frontend build. Mermaid export in M3. |
| Q15 | Node click | Symbol-only diff, "open in editor" link; behavior steps drill down to the code that implements them. |
| Q16 | Removals | Graph built on both before and after versions; removed nodes/edges shown dashed red. |
| Q17 | Huge diffs | Above a threshold, start collapsed at cluster level (M3). |
| Q18 | LLM role | **Revised after P1.** Writes levels 0–1: story, request coverage, what to verify, behavior flowchart. May create behavior steps, but each step must be anchored to level-2 ids; output is schema-validated, unknown anchors dropped, links graded grounded/inferred. |
| Q19 | Storage | **Revised by S4/S6.** Full task data cached in `~/.claude/flow/`, kept forever (no retention); the history record lives in the repo. |
| Q20 | `/flow` windows | **Superseded by S2/S14.** Tasks stay per turn; `/flow start "name" … end` names the feature they are grouped under; `SessionEnd` closes an open window. |
| Q21 | Config | `~/.claude/flow.json` + `<repo>/.claude/flow.json` overrides (M3). |
| Q22 | Roadmap | **Revised after S1–S14.** M1 core loop · M2 levels 0–1 (narrative + anchored behavior flow) · M3 development history (S1–S14), including the request fix of S13 · M4 big diffs, config file, Mermaid export, Nx project graph, publishing. |
| Q23 | Location | This repo. |
| Q24 | Server security | Bound to 127.0.0.1, random per-run token, Host-header check. |
| Q25 | Tests | Fixture git repos + end-to-end hook tests; the LLM is tested only on schema. |

## Development history (M3)

The history is a personal memory of the project — what was done, when and
why — and later context for Claude itself (S1). It lives in the repository,
next to the code it explains.

| # | Topic | Decision |
|---|---|---|
| S1 | Purpose | Personal memory of the project; later, memory Claude can consult. |
| S2 | Unit | The task (one Claude turn) is recorded; the view groups tasks. |
| S3 | Coverage | Only work done through Claude; manual commits are out of scope. |
| S4 | Retention | Keep everything, forever (replaces the 30-day retention of Q19). |
| S5 | Git link | Computed, never written to git: each task is "included in <commit>", "partially included", "not committed yet" or "never committed". |
| — | Backfill | No reconstruction of tasks from before the plugin was installed. |
| S6 | What goes in the repo | A light record: request, intent, story, flow, symbol references, task metadata. Diffs and the full graph stay in the local cache; for committed tasks they can be rebuilt from the commit. |
| S7 | Format | One Markdown file per task (story, asks, verify, Mermaid flowchart — readable anywhere) plus a JSON sidecar for the viewer. |
| S8 | Location | `docs/flow/` by default, configurable. |
| S9 | Who commits | The developer, together with the code: fcc writes the record in the working tree; fcc excludes its own directory from the analysis. |
| S10 | Privacy | The repo gets the intent summary, never the raw messages (those stay in the local cache); `/flow private` keeps a task out of the repo entirely. |
| S11 | Browsing | Project timeline and full-text search first; per-code-area view next; periodic digests later. |
| S12 | Access | A "History" tab in the viewer, opened with `/flow` from Claude Code, reading `docs/flow/` (so teammates' tasks appear after a pull). The Markdown files are readable without fcc, in the IDE and on GitHub. No shared index file (merge conflicts). |
| S13 | What "the request" is | All user messages since the previous task, read from the Claude Code transcript, plus an intent summary written by the model: goal, decisions, rejected alternatives. Also fixes M2, which judged the asks against the last message only (after a grilling session that is just "ok, go"). |
| S14 | Grouping | Explicit features via `/flow start "name"` … `/flow end`; otherwise tasks included in the same commit form a group titled by the commit message; uncommitted tasks group by session. No LLM clustering (unstable groups). |

Checks done before building:

- **Transcript**: user messages, skill invocations (`/name args`) and the
  assistant's prose are all there; tool calls/results (`tool_result`), skill
  bodies (`isMeta`) and subagents (`isSidechain`) are filtered out. Finding:
  user messages alone are not enough ("I accept your recommendations" means
  nothing without the recommendations), so the assistant's text is included.
- **Mermaid in PhpStorm**: rendered by the Markdown preview, the Mermaid
  plugin is bundled and enabled by default.
- **Task ↔ commit**: matched by content (hashes of meaningful added/removed
  lines, path-insensitive), tested on plain commits, squash, rebase, partial
  rewrites and discarded work.

How it works:

- **Conversation** (`src/history/conversation.ts`): messages after the end of
  the session's previous task, up to this task's end. Budgets: 4k chars per
  user message, 3k per assistant message (10k for the last one, usually the
  plan being approved), 60k total, trimming the oldest assistant text first.
  Kept in the local cache only.
- **Record** (`src/history/record.ts`): written after the story is ready,
  `docs/flow/<yyyy-mm>/<task id>-<slug>.{md,json}`. The analysis ignores this
  directory, so a record written during the next task never shows up as a
  change. Without a story (LLM off or failed) the record is factual only
  ("N files changed"), never the raw prompt.
- **Commit link** (`src/history/commits.ts`): one `git log -p -U0` of the
  current branch since the oldest task; included ≥ 80 % of the task's lines,
  partial ≥ 20 %, otherwise uncommitted (still in the work tree) or
  discarded. Computed when the History tab loads, never stored.
- **`/flow`** is a plugin skill (`skills/flow/SKILL.md`) that runs
  `fcc flow --session ${CLAUDE_SESSION_ID} --cwd ${CLAUDE_PROJECT_DIR}` and
  relays the output. Feature and privacy are per-session state
  (`~/.claude/flow/sessions/<id>/meta.json`).
- **Teammates' tasks**: records pulled from the repo appear in the timeline;
  opening one rebuilds its story from the record (no diffs or call edges:
  those stay in the author's cache, and git has the code).

## Architecture

```
UserPromptSubmit ─► snapshot work tree ─► ~/.claude/flow/sessions/<session>/current.json
PostToolUse      ─► append {tool, files} ─► …/tools.jsonl
Stop             ─► snapshot again; if Claude used tools and the tree changed:
                    write tasks/<id>/graph.json {status: pending}
                    spawn `fcc analyze` (detached):
                      static graph  ─► graph.json {status: ready, narrative: pending}   (seconds)
                      narrative     ─► graph.json {narrative: ready | error}           (~1 min)
                    ensure `fcc serve` is running            ─► prints the link
browser          ─► http://127.0.0.1:<port>/?t=<token>#/<repo>/<task>
                    opens on Story (levels 0–1), Structure tab = levels 2–3;
                    polls while anything is pending
```

- **Narrative (M2)**: the model receives the request, changed files (with
  attribution), changed symbols with their diffs, context symbols and edges,
  each under a short ref (`s1`, `f2`…); it answers with schema-constrained
  JSON (`--json-schema` / `output_config.format`). Refs are mapped back to
  graph ids, unknown ones dropped, links graded grounded/inferred
  (`src/narrative/validate.ts`). The text follows the language of the request.
  Default engine: `claude -p --system-prompt … --tools "" --setting-sources ""
  --strict-mcp-config --disable-slash-commands`, cwd in tmp, `FCC_DISABLE=1`
  so fcc's own hooks stay quiet in that session. Measured on the demo task:
  36–45 s, ~$0.06 (vs 54 s / $0.26 with a default `claude -p` session).
  A failed narrative never hides the static graph.

- **Snapshots** use a throwaway index (`GIT_INDEX_FILE` + `git add -A` +
  `git write-tree`): tracked and untracked files, `.gitignore` honored, the
  real index, HEAD and stash untouched. `git stash create` was rejected
  because it ignores untracked files.
- **Analysis** reads both trees straight from git objects, so it is
  deterministic and immune to edits made after `Stop`. Each version is loaded
  in an in-memory ts-morph project (compiler options from the root
  `tsconfig.base.json`/`tsconfig.json`, so `paths` aliases resolve).
- **Symbols** are top-level declarations and members of top-level classes;
  anything nested belongs to its enclosing symbol; top-level side-effect
  statements pool into a `(module)` symbol; imports never count as a change.
  A symbol changed when its text differs between versions.
- **Edges** (call / new / render / ref) are collected for every changed symbol
  in both versions — outgoing by resolving call sites, incoming via
  find-references — then diffed: in both = unchanged, only after = added,
  only before = removed.
- **Attribution**: a changed file is `claude` if written through an edit tool,
  otherwise `other` (shell command, the user, another session) and shown as
  "external".

## Deviations found during M1

- **D1 — the static graph is asynchronous too.** Q7 planned a synchronous
  static graph (< 1 s). On a real 2,100-file Nx repo ts-morph needs ~2.5 s, so
  the only synchronous work is the snapshot (~0.1 s); the page shows
  "Analyzing…" and refreshes itself when the graph is ready.
- **D2 — bundling moved from M3 to M1.** Hooks run with the *project's* Node
  (version managers pick it from the cwd), which may be older than 22.18 and
  unable to run TypeScript. `dist/` is an esbuild bundle targeting Node 18,
  code-split so hooks start in ~25 ms and TypeScript loads only for analysis.
  `dist/` is committed because plugins are installed without `npm install`.
- **D3 — Nx `project.json` clusters brought forward** from M3 (two lines).
- **D4 — session state is keyed by `session_id` only**, not by repo, because
  Claude's cwd can change during a session.

## Prototype P1 — narrative levels (2026-09-22)

Question: are levels 0–1 speaking enough to review a task without reading
code? Tried on the "discount codes" demo task with Haiku and Sonnet via
`claude -p` (`prototypes/narrative/`, throwaway).

- **Sonnet: yes.** It marked "show the discounted amount" as *missing*,
  flagged the migration created by a shell command, the error thrown on an
  invalid code but never handled by the UI, and an unrequested change to how
  order ids are generated. The flowchart showed the valid/invalid branch.
- **Haiku: not enough.** Rated the missing ask as "partial", no invalid-code
  branch, did not notice the unrequested change.
- **Anchoring held**: 0 unknown anchors, every link grounded in the call graph
  (small task; to be confirmed on large ones).
- **Cost was the problem**: 54–66 s and $0.10–0.26 per task with a default
  `claude -p` session, although the input itself is a few thousand tokens.
  Presumed cause: the full Claude Code context loaded in every session —
  hence the minimal-context invocation in Q8, to be measured.
- The story and the verify list carried most of the value; the flowchart
  helps orient.

## Known limitations

- An interrupted turn (no `Stop`) is dropped: the next prompt starts a new snapshot.
- A turn with no tool calls produces no diagram even if files changed (by
  design: that would be the user editing).
- Resolution is repo-local: calls through values typed by `node_modules`
  packages, dependency injection, events and dynamic dispatch are not linked.
- Only the root tsconfig is read (no `extends`, no per-project tsconfigs).
- Snapshots add unreferenced blobs to the repo's object store; `git gc` prunes them.
- The story takes ~40–60 s with Sonnet; the structure view is usable meanwhile.
- The narrative is only as good as what it sees: diffs above ~120k characters
  are shortened, and it cannot know about runtime behavior the static graph
  misses (see above), so its flow may be coarser there.
- History: commit matching looks at the current branch only; a task
  committed on an unmerged branch shows as "not committed yet". Lines that
  are very common (`return true;`) can inflate the match slightly.
- History: tasks made before M3 (or before installing the plugin) are not
  reconstructed (by decision).
- No config file, big-diff collapsing, Mermaid export of the structure graph
  or Nx project graph yet (M4).
