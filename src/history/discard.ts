import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { taskDir } from "../paths.ts";
import { readGraph, writeGraph } from "../tasks.ts";
import { removeRecord } from "./record.ts";

export interface DiscardResult {
  ok: boolean;
  /** What happened, ready to show to the user. */
  message: string;
  /** The record was already committed, so its removal shows up in git status. */
  wasCommitted?: boolean;
  recordPath?: string;
}

/**
 * Take one report out of the repo so it is never committed, keeping the task
 * itself in the local cache (you can still read it in the viewer). The task is
 * marked private, so a re-analysis does not write the record again.
 */
export function discardRecord(repoId: string, taskId: string): DiscardResult {
  const graph = readGraph(repoId, taskId);
  if (!graph) return { ok: false, message: "Task not found." };
  const recordPath = graph.recordPath;
  graph.task.private = true;
  delete graph.recordPath;
  writeGraph(graph);
  if (!recordPath) return { ok: true, message: "This task had no report in the repo; it will not get one." };
  const existed = existsSync(path.join(graph.task.repoRoot, recordPath));
  removeRecord(graph.task.repoRoot, recordPath);
  return {
    ok: true,
    recordPath,
    message: existed
      ? `Removed ${recordPath} from the working tree.`
      : `${recordPath} was already gone; the task will not write it again.`,
  };
}

/** Remove the report and the local task: nothing of it is left anywhere. */
export function deleteTask(repoId: string, taskId: string): DiscardResult {
  const dropped = discardRecord(repoId, taskId);
  if (!dropped.ok) return dropped;
  rmSync(taskDir(repoId, taskId), { recursive: true, force: true });
  return { ...dropped, message: `${dropped.message} The task was deleted from the local cache too.` };
}
