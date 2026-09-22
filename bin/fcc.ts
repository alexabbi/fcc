#!/usr/bin/env node
import { onPrompt, onStop, onTool, type HookInput, type HookOutput } from "../src/hooks.ts";
import { logError } from "../src/log.ts";

const USAGE = `usage:
  fcc hook <prompt|tool|stop>   run as a Claude Code hook (JSON on stdin)
  fcc analyze <repoId> <taskId> build the graph for a recorded task
  fcc serve                     start the local viewer server
  fcc open                      print the viewer URL (starting the server if needed)
  fcc flow --session <id> --cwd <dir> [start "name" | end | private | public]
                                history and feature grouping (used by the /flow skill)`;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const HANDLERS: Record<string, (input: HookInput) => HookOutput | Promise<HookOutput>> = {
  prompt: onPrompt,
  tool: onTool,
  stop: onStop,
};

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "hook": {
      const handler = HANDLERS[args[0] ?? ""];
      if (!handler) throw new Error(USAGE);
      // Set on the headless session fcc itself starts to write the narrative.
      if (process.env.FCC_DISABLE === "1") return;
      try {
        const output = await handler(JSON.parse(await readStdin()));
        // UserPromptSubmit stdout is injected into Claude's context: print only real output.
        if (output.systemMessage) process.stdout.write(JSON.stringify(output));
      } catch (err) {
        logError(`hook ${args[0]}`, err);
      }
      return;
    }
    case "analyze": {
      const { runAnalysis } = await import("../src/analysis-job.ts");
      try {
        await runAnalysis(args[0]!, args[1]!);
      } catch (err) {
        logError("analyze", err);
        process.exitCode = 1;
      }
      return;
    }
    case "serve": {
      const { startServer } = await import("../src/server/server.ts");
      startServer();
      return;
    }
    case "open": {
      const { ensureServer } = await import("../src/server/launcher.ts");
      const info = await ensureServer();
      if (!info) throw new Error("server did not start; see ~/.claude/flow/fcc.log");
      console.log(`http://127.0.0.1:${info.port}/?t=${info.token}`);
      return;
    }
    case "flow": {
      const { flowCommand } = await import("../src/flow-command.ts");
      console.log(await flowCommand(args));
      return;
    }
    default:
      console.error(USAGE);
      process.exitCode = 2;
  }
}

main().catch((err) => {
  // serve/analyze run detached with no terminal: the log is the only trace.
  logError(process.argv[2] ?? "cli", err);
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
