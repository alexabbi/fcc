import type { FlowGraph } from "../graph/types.ts";
import type { Narrative, NarrativeChecks } from "./types.ts";

const MAX_HOPS = 3;

/**
 * Map refs back to graph ids, drop anything the graph does not contain, and
 * grade each flow link: grounded when the code behind its two steps is
 * connected in the call graph within a few hops.
 */
export function validateNarrative(
  raw: unknown,
  refs: Map<string, string>,
  graph: FlowGraph,
): { narrative: Narrative; checks: NarrativeChecks } {
  const r = raw as Record<string, any>;
  const checks: NarrativeChecks = { droppedAnchors: 0, unanchoredSteps: 0, groundedLinks: 0, inferredLinks: 0 };
  const anchors = (list: unknown): string[] => {
    const out: string[] = [];
    for (const ref of Array.isArray(list) ? list : []) {
      const id = refs.get(String(ref));
      if (id) {
        if (!out.includes(id)) out.push(id);
      } else {
        checks.droppedAnchors++;
      }
    }
    return out;
  };
  const text = (v: unknown) => (typeof v === "string" ? v : "");

  const steps: Narrative["flow"]["steps"] = [];
  const seen = new Set<string>();
  for (const s of arr(r.flow?.steps)) {
    const id = text(s.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const step = {
      id,
      label: text(s.label),
      detail: text(s.detail),
      kind: s.kind ?? "action",
      status: s.status ?? "unchanged",
      anchors: anchors(s.anchors),
    };
    if (step.anchors.length === 0 && step.kind !== "trigger" && step.kind !== "outcome") checks.unanchoredSteps++;
    steps.push(step);
  }

  const byId = new Map(steps.map((s) => [s.id, s]));
  const connected = connectivity(graph);
  const links: Narrative["flow"]["links"] = [];
  for (const l of arr(r.flow?.links)) {
    const from = byId.get(text(l.from));
    const to = byId.get(text(l.to));
    if (!from || !to) continue;
    // A step with no code (trigger/outcome) cannot contradict the graph.
    const grounded =
      from.anchors.length === 0 ||
      to.anchors.length === 0 ||
      from.anchors.some((a) => to.anchors.some((b) => connected(a, b)));
    if (grounded) checks.groundedLinks++;
    else checks.inferredLinks++;
    links.push({ from: from.id, to: to.id, ...(text(l.label) ? { label: text(l.label) } : {}), grounded });
  }

  return {
    narrative: {
      intent: {
        goal: text(r.intent?.goal),
        decisions: strs(r.intent?.decisions),
        rejected: strs(r.intent?.rejected),
      },
      headline: text(r.headline),
      story: text(r.story),
      asks: arr(r.asks).map((a) => ({ request: text(a.request), status: a.status ?? "partial", note: text(a.note), anchors: anchors(a.anchors) })),
      verify: arr(r.verify).map((v) => ({ priority: v.priority ?? "medium", text: text(v.text), anchors: anchors(v.anchors) })),
      flow: { title: text(r.flow?.title), steps, links },
    },
    checks,
  };
}

function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
}

function arr(v: unknown): Record<string, any>[] {
  return Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : [];
}

/** Undirected reachability within MAX_HOPS over call edges and symbol↔file membership. */
function connectivity(graph: FlowGraph): (a: string, b: string) => boolean {
  const adj = new Map<string, Set<string>>();
  const link = (x: string, y: string) => {
    if (!adj.has(x)) adj.set(x, new Set());
    if (!adj.has(y)) adj.set(y, new Set());
    adj.get(x)!.add(y);
    adj.get(y)!.add(x);
  };
  for (const e of graph.edges) link(e.source, e.target);
  for (const n of graph.nodes) if (n.kind === "symbol") link(n.id, n.parent);
  return (a, b) => {
    if (a === b) return true;
    let frontier = [a];
    const seen = new Set([a]);
    for (let hop = 0; hop < MAX_HOPS && frontier.length; hop++) {
      const next: string[] = [];
      for (const n of frontier) {
        for (const m of adj.get(n) ?? []) {
          if (m === b) return true;
          if (!seen.has(m)) {
            seen.add(m);
            next.push(m);
          }
        }
      }
      frontier = next;
    }
    return false;
  };
}
