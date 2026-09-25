import { randomBytes } from "node:crypto";
import path from "node:path";
import { hasDecision, isProjectEnabled, readConfig, takeHint } from "./config.ts";
import { findRepoRoot, headCommit, snapshotWorkTree } from "./git.ts";
import type { TaskInfo } from "./graph/types.ts";
import { repoIdFor } from "./paths.ts";
import { ensureServer, taskUrl } from "./server/launcher.ts";
import { spawnSelfDetached } from "./spawn.ts";
import { beginTask, endTask, readCurrentTask, readSessionMeta, readToolRecords, recordTool, updateSessionMeta } from "./session.ts";
import { registerRepo, writeGraph } from "./tasks.ts";

/** Subset of the JSON Claude Code sends to hooks on stdin. */
export interface HookInput {
  session_id: string;
  cwd: string;
  transcript_path?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    notebook_path?: string;
    edits?: { file_path?: string }[];
  };
}

export interface HookOutput {
  systemMessage?: string;
}

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** UserPromptSubmit: remember the state of the work tree before Claude starts. */
export function onPrompt(input: HookInput): HookOutput {
  const repoRoot = findRepoRoot(input.cwd);
  if (!repoRoot) return {};
  if (!isProjectEnabled(repoRoot)) {
    // Say it once per repository, then never again: a plugin that records
    // nothing and says nothing looks broken, one that nags is worse.
    if (!hasDecision(repoRoot) && takeHint(repoRoot)) {
      return { systemMessage: "fcc is installed but not active in this project. Run /flow on to have it explain each task here." };
    }
    return {};
  }
  beginTask(input.session_id, {
    repoRoot,
    beforeTree: snapshotWorkTree(repoRoot),
    baseCommit: headCommit(repoRoot),
    startedAt: new Date().toISOString(),
  });
  return {};
}

/** PostToolUse: note which files Claude itself wrote, and whether it ran shell commands. */
export function onTool(input: HookInput): HookOutput {
  if (!readCurrentTask(input.session_id)) return {};
  const tool = input.tool_name ?? "";
  const ti = input.tool_input ?? {};
  const files = WRITE_TOOLS.has(tool)
    ? [ti.file_path, ti.notebook_path, ...(ti.edits ?? []).map((e) => e.file_path)]
        .filter((f): f is string => typeof f === "string")
        .map((f) => path.resolve(input.cwd, f))
    : [];
  recordTool(input.session_id, { tool, files });
  return {};
}

/** Stop: snapshot again, and if anything changed, queue the analysis and print the link. */
export async function onStop(input: HookInput): Promise<HookOutput> {
  const current = readCurrentTask(input.session_id);
  if (!current) return {};
  const records = readToolRecords(input.session_id);
  endTask(input.session_id);
  // A turn that neither wrote files nor ran commands produces no diagram,
  // even if the tree changed (that would be the user editing in parallel).
  if (records.length === 0) return {};

  const afterTree = snapshotWorkTree(current.repoRoot);
  if (afterTree === current.beforeTree) return {};

  const repoId = repoIdFor(current.repoRoot);
  registerRepo(repoId, current.repoRoot);
  const meta = readSessionMeta(input.session_id);
  const claudeFiles = new Set<string>();
  for (const r of records) {
    for (const f of r.files) {
      const rel = path.relative(current.repoRoot, f);
      if (!rel.startsWith("..") && !path.isAbsolute(rel)) claudeFiles.add(rel.split(path.sep).join("/"));
    }
  }
  const task: TaskInfo = {
    id: newTaskId(),
    repoId,
    repoRoot: current.repoRoot,
    sessionId: input.session_id,
    startedAt: current.startedAt,
    endedAt: new Date().toISOString(),
    before: current.beforeTree,
    after: afterTree,
    claudeFiles: [...claudeFiles].sort(),
    usedBash: records.some((r) => r.tool === "Bash"),
    ...(input.transcript_path ? { transcriptPath: input.transcript_path } : {}),
    ...(meta.lastTaskEndedAt ? { conversationSince: meta.lastTaskEndedAt } : {}),
    ...(meta.feature ? { feature: meta.feature } : {}),
    ...(meta.private ? { private: true } : {}),
    ...(current.baseCommit ? { baseCommit: current.baseCommit } : {}),
  };
  // The next task's conversation starts after this one (S13).
  updateSessionMeta(input.session_id, { lastTaskEndedAt: task.endedAt, lastTaskId: task.id, lastRepoId: repoId });
  const { mode } = readConfig(current.repoRoot);
  writeGraph({ version: 1, task, status: mode === "manual" ? "captured" : "pending", nodes: [], edges: [], warnings: [] });

  // Manual: the snapshots cost nothing and are kept, but nothing is analyzed
  // or sent to a model until the developer asks for this task.
  if (mode === "manual") {
    const n = task.claudeFiles.length;
    return { systemMessage: `fcc: ${n || "no"} file${n === 1 ? "" : "s"} captured. /flow last to explain this task.` };
  }

  if (process.env.FCC_SYNC === "1") {
    const { runAnalysis } = await import("./analysis-job.ts");
    await runAnalysis(repoId, task.id);
  } else {
    spawnSelfDetached(["analyze", repoId, task.id]);
  }

  if (process.env.FCC_NO_SERVER === "1") return {};
  const server = await ensureServer();
  if (!server) return { systemMessage: "fcc: diagram queued, but the local server did not start (see ~/.claude/flow/fcc.log)" };
  const s = task.claudeFiles.length;
  return { systemMessage: `fcc: flowchart of ${s} file${s === 1 ? "" : "s"} → ${taskUrl(server, repoId, task.id)}` };
}

/** Sortable and unique enough: 20260922-153012-a1b2. */
function newTaskId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${stamp}-${randomBytes(2).toString("hex")}`;
}
