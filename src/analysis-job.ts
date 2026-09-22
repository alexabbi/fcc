import { treeDiff } from "./git.ts";
import { analyzeTask } from "./graph/analyze.ts";
import { isExcludedChange } from "./graph/filters.ts";
import type { FlowGraph } from "./graph/types.ts";
import { readConversation } from "./history/conversation.ts";
import { fingerprintFromDiff } from "./history/fingerprint.ts";
import { buildRecord, historyDir, writeRecord } from "./history/record.ts";
import { generateNarrative } from "./narrative/generate.ts";
import { llmSettings, type LlmRunner } from "./narrative/llm.ts";
import { readGraph, writeGraph } from "./tasks.ts";
import { logError } from "./log.ts";

/**
 * Turn a pending graph.json into a ready one: first the static graph
 * (levels 2–3, seconds), written immediately so the page can show it, then the
 * narrative (levels 0–1, tens of seconds), then the history record in the repo.
 */
export async function runAnalysis(repoId: string, taskId: string, runner?: LlmRunner): Promise<FlowGraph> {
  const pending = readGraph(repoId, taskId);
  if (!pending) throw new Error(`task not found: ${repoId}/${taskId}`);

  let graph: FlowGraph;
  try {
    graph = { ...pending, ...analyzeTask(pending.task), status: "ready" };
    graph.fingerprint = taskFingerprint(pending);
    const t = pending.task;
    if (t.transcriptPath) graph.conversation = readConversation(t.transcriptPath, t.conversationSince, t.endedAt);
  } catch (err) {
    writeGraph({ ...pending, status: "error", error: message(err) });
    throw err;
  }

  const settings = llmSettings();
  if (!settings || graph.nodes.length === 0) {
    graph.narrative = { status: "off" };
  } else {
    graph.narrative = { status: "pending", engine: settings.engine, model: settings.model };
    writeGraph(graph);
    try {
      graph.narrative = await generateNarrative(graph, settings, runner);
    } catch (err) {
      graph.narrative = { status: "error", engine: settings.engine, model: settings.model, error: message(err) };
    }
  }

  if (!graph.task.private && graph.nodes.length > 0) {
    try {
      graph.recordPath = writeRecord(graph.task.repoRoot, buildRecord(graph), graph.recordPath);
    } catch (err) {
      logError("record", err); // the local task is still complete
    }
  }
  writeGraph(graph);
  return graph;
}

/** Line keys of the whole change, minus excluded files and fcc's own records. */
function taskFingerprint(graph: FlowGraph) {
  const fp = fingerprintFromDiff(treeDiff(graph.task.repoRoot, graph.task.before, graph.task.after));
  const ownDir = `${historyDir()}/`;
  for (const p of Object.keys(fp)) if (p.startsWith(ownDir) || isExcludedChange(p)) delete fp[p];
  return fp;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
