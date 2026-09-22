import type { FlowGraph, SymbolNode, FileNode } from "../graph/types.ts";

/** Rough cap on the serialized input; above it diffs are shortened. */
const MAX_INPUT_CHARS = 120_000;
const TRIMMED_DIFF_LINES = 40;

export const SYSTEM_PROMPT = `You explain a finished coding task to the developer who delegated it to an AI agent and wants to review it WITHOUT reading the code.
You receive the developer's request, the changed files, the changed symbols with their diffs, unchanged neighbor symbols (status "context"), and call-graph edges (status added/removed/unchanged). Every file and symbol has a short ref (f1, s1…).
Write all text in the language of the developer's request.

Produce:
- headline: one line saying what the task changed, in product/domain terms.
- story: 2-4 sentences describing the behavior BEFORE vs AFTER, in domain language. No function or file names.
- asks: split the developer's request into its individual asks. For each: done / partial / missing, judged strictly from the diffs, with a short note. Be skeptical: if an ask is not visibly implemented, it is "missing".
- verify: what the developer should personally check, most important first. Look for: behavior changes for existing callers, changes not made by the agent's edit tools (writtenBy "external"), data/schema changes, unhandled errors and edge cases, changes nobody asked for, missing tests, mismatches with the request. Concrete and short, no generic advice. Empty if there is truly nothing.
- flow: a flowchart of the runtime behavior touched by the task, from the trigger (user action, API call, job…) to the outcome(s). 4-12 steps. Labels in domain language, at most 6 words, no identifiers. Decisions are "decision" steps with labeled outgoing links (e.g. "valid" / "invalid", in the request's language). Mark each step added / modified / removed / unchanged relative to the old behavior; include removed behavior as removed steps when relevant. If the change is not about runtime behavior (config, docs, refactor), show the affected flow at a coarser grain or what the change enables.

Rules: anchors may only contain refs from the input. Every step except trigger/outcome must have at least one anchor pointing to the code that implements it. Never describe behavior you cannot point to. Step ids are short unique strings.`;

export interface NarrativeInput {
  /** JSON sent as the user message. */
  text: string;
  /** JSON schema for the structured output. */
  schema: object;
  /** ref (s1, f1…) -> graph node id. */
  refs: Map<string, string>;
  trimmed: boolean;
}

export function buildInput(graph: FlowGraph): NarrativeInput {
  const files = graph.nodes.filter((n): n is FileNode => n.kind === "file" && n.status !== "context");
  const symbols = graph.nodes.filter((n): n is SymbolNode => n.kind === "symbol");
  const refs = new Map<string, string>();
  const refOf = new Map<string, string>();
  files.forEach((f, i) => (refs.set(`f${i + 1}`, f.id), refOf.set(f.id, `f${i + 1}`)));
  symbols.forEach((s, i) => (refs.set(`s${i + 1}`, s.id), refOf.set(s.id, `s${i + 1}`)));

  const build = (diffLines?: number) => ({
    request: graph.task.prompt,
    agentRanShellCommands: graph.task.usedBash,
    changedFiles: files.map((f) => ({
      ref: refOf.get(f.id),
      path: f.path,
      status: f.status,
      ...(f.oldPath ? { renamedFrom: f.oldPath } : {}),
      writtenBy: f.attribution === "claude" ? "agent edit tool" : "external (shell command, the user, or another session)",
      // Parsed code files are described by their symbols; only opaque files carry a file diff.
      ...(f.opaque && f.diff ? { diff: cut(f.diff, diffLines) } : {}),
    })),
    symbols: symbols.map((s) => ({
      ref: refOf.get(s.id),
      name: s.label,
      kind: s.symbolKind,
      file: s.path,
      status: s.status,
      ...(s.diff ? { diff: cut(s.diff, diffLines) } : {}),
    })),
    edges: graph.edges.map((e) => ({ from: refOf.get(e.source), to: refOf.get(e.target), kind: e.kind, status: e.status })),
    notes: graph.warnings,
  });

  let text = JSON.stringify(build(), null, 1);
  let trimmed = false;
  if (text.length > MAX_INPUT_CHARS) {
    text = JSON.stringify(build(TRIMMED_DIFF_LINES), null, 1);
    trimmed = true;
  }
  return { text, schema: outputSchema([...refs.keys()]), refs, trimmed };
}

function cut(diff: string, lines?: number): string {
  if (!lines) return diff;
  const all = diff.split("\n");
  return all.length <= lines ? diff : all.slice(0, lines).join("\n") + `\n… ${all.length - lines} more lines`;
}

function outputSchema(refs: string[]): object {
  const obj = (properties: Record<string, object>, required = Object.keys(properties)) => ({
    type: "object",
    properties,
    required,
    additionalProperties: false,
  });
  const str = { type: "string" };
  const anchors = { type: "array", items: refs.length > 0 && refs.length <= 400 ? { type: "string", enum: refs } : str };
  return obj({
    headline: str,
    story: str,
    asks: {
      type: "array",
      items: obj({ request: str, status: { type: "string", enum: ["done", "partial", "missing"] }, note: str, anchors }),
    },
    verify: {
      type: "array",
      items: obj({ priority: { type: "string", enum: ["high", "medium", "low"] }, text: str, anchors }),
    },
    flow: obj({
      title: str,
      steps: {
        type: "array",
        items: obj({
          id: str,
          label: str,
          detail: str,
          kind: { type: "string", enum: ["trigger", "action", "decision", "data", "outcome"] },
          status: { type: "string", enum: ["added", "modified", "removed", "unchanged"] },
          anchors,
        }),
      },
      links: { type: "array", items: obj({ from: str, to: str, label: str }, ["from", "to", "label"]) },
    }),
  });
}
