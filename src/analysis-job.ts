import { analyzeTask } from "./graph/analyze.ts";
import type { FlowGraph } from "./graph/types.ts";
import { generateNarrative } from "./narrative/generate.ts";
import { llmSettings, type LlmRunner } from "./narrative/llm.ts";
import { readGraph, writeGraph } from "./tasks.ts";

/**
 * Turn a pending graph.json into a ready one: first the static graph
 * (levels 2–3, seconds), written immediately so the page can show it, then the
 * narrative (levels 0–1, tens of seconds).
 */
export async function runAnalysis(repoId: string, taskId: string, runner?: LlmRunner): Promise<FlowGraph> {
  const pending = readGraph(repoId, taskId);
  if (!pending) throw new Error(`task not found: ${repoId}/${taskId}`);

  let graph: FlowGraph;
  try {
    graph = { ...pending, ...analyzeTask(pending.task), status: "ready" };
  } catch (err) {
    writeGraph({ ...pending, status: "error", error: message(err) });
    throw err;
  }

  const settings = llmSettings();
  if (!settings || graph.nodes.length === 0) {
    graph.narrative = { status: "off" };
    writeGraph(graph);
    return graph;
  }
  graph.narrative = { status: "pending", engine: settings.engine, model: settings.model };
  writeGraph(graph);

  try {
    graph.narrative = await generateNarrative(graph, settings, runner);
  } catch (err) {
    graph.narrative = { status: "error", engine: settings.engine, model: settings.model, error: message(err) };
  }
  writeGraph(graph);
  return graph;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
