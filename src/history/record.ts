import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FileNode, FlowGraph, SymbolNode } from "../graph/types.ts";
import type { Ask, Intent, Narrative, VerifyItem } from "../narrative/types.ts";
import type { Fingerprint } from "./fingerprint.ts";

/**
 * The part of a task that lives in the repository (S6): why it was done and
 * what it changed, never the raw conversation (S10) nor the diffs (git has
 * the code). One Markdown file for people (S7) and a JSON sidecar for fcc.
 */
export interface HistoryRecord {
  fcc: 1;
  task: {
    id: string;
    startedAt: string;
    endedAt: string;
    /** First 8 chars of the Claude Code session id: enough to group, nothing more. */
    session: string;
    feature?: string;
    baseCommit?: string;
    model?: string;
  };
  headline: string;
  story: string;
  intent: Intent;
  asks: Ask[];
  verify: VerifyItem[];
  flow?: Narrative["flow"];
  files: { path: string; status: string; oldPath?: string; by?: "claude" | "other" }[];
  /** Changed symbols and anything the story points to. */
  symbols: { id: string; label: string; kind: string; status: string; path: string; line: number }[];
  fingerprint: Fingerprint;
}

export const DEFAULT_HISTORY_DIR = "docs/flow";

export function historyDir(env = process.env): string {
  return (env.FCC_HISTORY_DIR ?? DEFAULT_HISTORY_DIR).replace(/^\/+|\/+$/g, "");
}

export function buildRecord(graph: FlowGraph): HistoryRecord {
  const t = graph.task;
  const n = graph.narrative?.status === "ready" ? graph.narrative.data : undefined;
  const files = graph.nodes.filter((x): x is FileNode => x.kind === "file" && x.status !== "context");
  const anchored = new Set(
    n ? [...n.asks, ...n.verify, ...n.flow.steps].flatMap((x) => x.anchors) : [],
  );
  const symbols = graph.nodes.filter(
    (x): x is SymbolNode => x.kind === "symbol" && (x.status !== "context" || anchored.has(x.id)),
  );
  return {
    fcc: 1,
    task: {
      id: t.id,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      session: t.sessionId.slice(0, 8),
      ...(t.feature ? { feature: t.feature } : {}),
      ...(t.baseCommit ? { baseCommit: t.baseCommit } : {}),
      ...(n ? { model: graph.narrative?.model } : {}),
    },
    // Without a story (LLM off or failed) the record stays factual: no raw prompt (S10).
    headline: n?.headline || `${files.length} file${files.length === 1 ? "" : "s"} changed`,
    story: n?.story ?? "",
    intent: n?.intent ?? { goal: "", decisions: [], rejected: [] },
    asks: n?.asks ?? [],
    verify: n?.verify ?? [],
    ...(n ? { flow: n.flow } : {}),
    files: files.map((f) => ({
      path: f.path,
      status: f.status,
      ...(f.oldPath ? { oldPath: f.oldPath } : {}),
      ...(f.attribution ? { by: f.attribution } : {}),
    })),
    symbols: symbols.map((s) => ({ id: s.id, label: s.label, kind: s.symbolKind, status: s.status, path: s.path, line: s.line })),
    fingerprint: graph.fingerprint ?? {},
  };
}

/** `docs/flow/2026-09/20260922-162416-16d4-codici-sconto` (without extension). */
export function recordBase(record: HistoryRecord, dir = historyDir()): string {
  const month = `${record.task.id.slice(0, 4)}-${record.task.id.slice(4, 6)}`;
  const slug = slugify(record.task.feature ?? record.headline);
  return `${dir}/${month}/${record.task.id}${slug ? `-${slug}` : ""}`;
}

/** Write (or overwrite) the record into the work tree; returns the repo-relative Markdown path. */
export function writeRecord(repoRoot: string, record: HistoryRecord, previousPath?: string): string {
  const base = recordBase(record);
  if (previousPath && previousPath !== `${base}.md`) removeRecord(repoRoot, previousPath);
  const abs = path.join(repoRoot, base);
  mkdirSync(path.dirname(abs), { recursive: true });
  atomicWrite(`${abs}.json`, JSON.stringify(record, null, 2) + "\n");
  atomicWrite(`${abs}.md`, renderMarkdown(record));
  return `${base}.md`;
}

export function removeRecord(repoRoot: string, mdPath: string): void {
  const abs = path.join(repoRoot, mdPath.replace(/\.md$/, ""));
  rmSync(`${abs}.md`, { force: true });
  rmSync(`${abs}.json`, { force: true });
}

/** Every record in the repo's history directory (teammates' included, after a pull). */
export function readRecords(repoRoot: string, dir = historyDir()): { record: HistoryRecord; path: string }[] {
  const root = path.join(repoRoot, dir);
  const out: { record: HistoryRecord; path: string }[] = [];
  const walk = (d: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.name.endsWith(".json")) {
        try {
          const record = JSON.parse(readFileSync(abs, "utf8"));
          if (record?.fcc === 1 && record.task?.id) {
            out.push({ record, path: path.relative(repoRoot, abs).split(path.sep).join("/").replace(/\.json$/, ".md") });
          }
        } catch {
          // a half-merged or hand-edited file: skip it
        }
      }
    }
  };
  walk(root);
  return out;
}

const MARK = { done: "✓", partial: "◐", missing: "✗" } as const;

export function renderMarkdown(r: HistoryRecord): string {
  const lines: string[] = [];
  // JSON strings are valid YAML scalars: no quoting surprises.
  const fm: Record<string, string | undefined> = {
    task: r.task.id,
    date: r.task.endedAt,
    feature: r.task.feature,
    session: r.task.session,
    base: r.task.baseCommit?.slice(0, 12),
    model: r.task.model,
  };
  lines.push("---", "fcc: 1");
  for (const [k, v] of Object.entries(fm)) if (v) lines.push(`${k}: ${JSON.stringify(v)}`);
  lines.push("---", "", `# ${r.headline}`, "");
  lines.push("<!-- Generated by fcc (Flowchart for Claude Code). The .json next to this file is what fcc reads. -->", "");

  if (r.intent.goal || r.intent.decisions.length || r.intent.rejected.length) {
    lines.push("## Why", "");
    if (r.intent.goal) lines.push(r.intent.goal, "");
    if (r.intent.decisions.length) lines.push("**Decisions**", "", ...r.intent.decisions.map((d) => `- ${d}`), "");
    if (r.intent.rejected.length) lines.push("**Rejected**", "", ...r.intent.rejected.map((d) => `- ${d}`), "");
  }
  if (r.story) lines.push("## What changed", "", r.story, "");
  if (r.asks.length) {
    lines.push("## Asks", "", ...r.asks.map((a) => `- ${MARK[a.status] ?? "?"} ${a.request}${a.note ? ` — ${a.note}` : ""}`), "");
  }
  if (r.verify.length) {
    lines.push("## To verify", "", ...r.verify.map((v) => `- **${v.priority}** ${v.text}`), "");
  }
  if (r.flow?.steps.length) {
    lines.push(`## Behavior${r.flow.title ? `: ${r.flow.title}` : ""}`, "", "```mermaid", ...mermaid(r.flow), "```", "");
  }
  if (r.files.length) {
    lines.push("## Files", "");
    for (const f of r.files) {
      const from = f.oldPath ? ` (from \`${f.oldPath}\`)` : "";
      const by = f.by === "other" ? " · external" : "";
      lines.push(`- \`${f.path}\` ${f.status}${from}${by}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function mermaid(flow: Narrative["flow"]): string[] {
  const ids = new Map(flow.steps.map((s, i) => [s.id, `s${i + 1}`]));
  const q = (t: string) => `"${t.replace(/"/g, "#quot;")}"`;
  const out = ["flowchart TD"];
  for (const s of flow.steps) {
    const id = ids.get(s.id)!;
    const label = q(s.label);
    const shape =
      s.kind === "decision" ? `{${label}}` : s.kind === "data" ? `[(${label})]` : s.kind === "trigger" || s.kind === "outcome" ? `([${label}])` : `[${label}]`;
    out.push(`  ${id}${shape}${s.status !== "unchanged" ? `:::${s.status}` : ""}`);
  }
  for (const l of flow.links) {
    const a = ids.get(l.from);
    const b = ids.get(l.to);
    if (!a || !b) continue;
    const label = l.label ?? (l.grounded ? "" : "inferred");
    const arrow = l.grounded ? "-->" : "-.->";
    out.push(`  ${a} ${arrow}${label ? `|${q(label)}|` : ""} ${b}`);
  }
  out.push(
    "  classDef added fill:#e3f3e7,stroke:#2f8a4c,color:#1f1e1c",
    "  classDef modified fill:#fbf0dc,stroke:#b7791f,color:#1f1e1c",
    "  classDef removed fill:#fbe4e2,stroke:#c2413a,color:#1f1e1c,stroke-dasharray:5 3",
  );
  return out;
}

function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/, "");
}

function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}
