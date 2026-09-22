# fcc — design

Flowchart for Claude Code: at the end of each Claude Code task, a visual,
plain-language account of what changed, so the developer can review the work
while reading less and less code.

This records the decisions taken in the design session (Q1–Q25), the
deviations found while building M1, and the revision after prototype P1.

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
| Q19 | Storage | `~/.claude/flow/`, nothing written in the user's repo; 30-day retention (M3). |
| Q20 | `/flow` windows | Per-turn diagrams suppressed inside a window; `SessionEnd` closes open windows (M3). |
| Q21 | Config | `~/.claude/flow.json` + `<repo>/.claude/flow.json` overrides (M3). |
| Q22 | Roadmap | **Revised after P1.** M1 core loop · M2 levels 0–1 (narrative + anchored behavior flow) and a page that opens on the story · M3 big diffs, `/flow start|end`, config, retention, Mermaid export, Nx project graph, publishing. |
| Q23 | Location | This repo. |
| Q24 | Server security | Bound to 127.0.0.1, random per-run token, Host-header check. |
| Q25 | Tests | Fixture git repos + end-to-end hook tests; the LLM is tested only on schema. |

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
- No retention, config file, big-diff collapsing or `/flow` yet (M3).
