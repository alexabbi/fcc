import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import type { Engine } from "./types.ts";

export interface LlmRequest {
  system: string;
  user: string;
  schema: object;
  model: string;
}

export interface LlmResult {
  output: unknown;
  costUsd?: number;
}

export type LlmRunner = (req: LlmRequest) => Promise<LlmResult>;

const TIMEOUT_MS = 4 * 60_000;

/** `FCC_LLM` = claude (default) | api | off; `FCC_MODEL` = sonnet (default) | haiku | opus | full model id. */
export function llmSettings(env = process.env): { engine: Engine; model: string } | null {
  const mode = (env.FCC_LLM ?? "claude").toLowerCase();
  if (mode === "off" || mode === "0" || mode === "false") return null;
  return { engine: mode === "api" ? "api" : "claude", model: env.FCC_MODEL ?? "sonnet" };
}

export function runnerFor(engine: Engine): LlmRunner {
  return engine === "api" ? runApi : runClaudeCli;
}

/**
 * Headless Claude Code with a minimal context: our system prompt replaces the
 * default one, and no tools, settings, plugins, MCP servers or skills are
 * loaded. Uses the user's existing Claude Code login, so no API key is needed.
 */
const runClaudeCli: LlmRunner = (req) =>
  new Promise((resolve, reject) => {
    const args = [
      "-p",
      "--model", req.model,
      "--output-format", "json",
      "--json-schema", JSON.stringify(req.schema),
      "--system-prompt", req.system,
      "--tools", "",
      "--setting-sources", "",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--max-turns", "3",
    ];
    // FCC_DISABLE keeps our own hooks quiet if the plugin is loaded anyway.
    const child = spawn("claude", args, { cwd: tmpdir(), env: { ...process.env, FCC_DISABLE: "1" } });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`could not run claude: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let res: Record<string, any>;
      try {
        res = JSON.parse(out);
      } catch {
        return reject(new Error(`claude -p exited ${code}: ${(err || out).slice(0, 500)}`));
      }
      if (res.is_error) return reject(new Error(`claude -p: ${String(res.result ?? res.subtype).slice(0, 500)}`));
      const output = res.structured_output ?? parseJsonText(String(res.result ?? ""));
      resolve({ output, costUsd: res.total_cost_usd });
    });
    child.stdin.end(req.user);
  });

const API_MODELS: Record<string, string> = {
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
  opus: "claude-opus-5",
};

/** $ per million tokens (input, output). */
const PRICES: Record<string, [number, number]> = {
  "claude-sonnet-5": [2, 10],
  "claude-haiku-4-5": [1, 5],
  "claude-opus-5": [5, 25],
};

/** Anthropic API through the official SDK; credentials resolved by the SDK (ANTHROPIC_API_KEY, profiles…). */
const runApi: LlmRunner = async (req) => {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ timeout: TIMEOUT_MS });
  const model = API_MODELS[req.model] ?? req.model;
  const response = await client.messages.create({
    model,
    max_tokens: 16000,
    system: req.system,
    messages: [{ role: "user", content: req.user }],
    output_config: { format: { type: "json_schema", schema: req.schema as Record<string, unknown> } },
  });
  if (response.stop_reason === "refusal") throw new Error("the model declined to describe this task");
  if (response.stop_reason === "max_tokens") throw new Error("the description was cut off (max_tokens)");
  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("no text in the model response");
  const price = PRICES[model];
  const costUsd = price
    ? (response.usage.input_tokens * price[0] + response.usage.output_tokens * price[1]) / 1_000_000
    : undefined;
  return { output: JSON.parse(text.text), costUsd };
};

function parseJsonText(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  return JSON.parse(fenced ? fenced[1]! : text);
}
