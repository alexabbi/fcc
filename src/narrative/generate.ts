import type { FlowGraph } from "../graph/types.ts";
import { runnerFor, type LlmRunner } from "./llm.ts";
import { buildInput, SYSTEM_PROMPT } from "./prompt.ts";
import type { Engine, NarrativeState } from "./types.ts";
import { validateNarrative } from "./validate.ts";

/** Ask the model for levels 0–1 and validate them against the graph. */
export async function generateNarrative(
  graph: FlowGraph,
  settings: { engine: Engine; model: string },
  runner: LlmRunner = runnerFor(settings.engine),
): Promise<NarrativeState> {
  const t0 = Date.now();
  const input = buildInput(graph);
  const { output, costUsd } = await runner({ system: SYSTEM_PROMPT, user: input.text, schema: input.schema, model: settings.model });
  const { narrative, checks } = validateNarrative(output, input.refs, graph);
  return {
    status: "ready",
    engine: settings.engine,
    model: settings.model,
    seconds: Math.round((Date.now() - t0) / 100) / 10,
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(input.trimmed ? { trimmed: true } : {}),
    checks,
    data: narrative,
  };
}
