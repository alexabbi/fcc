import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  configSource,
  DEFAULT_CONFIG,
  forgetProject,
  isProjectEnabled,
  MODEL_CHOICES,
  readConfig,
  setProjectEnabled,
  writeConfig,
} from "./config.ts";
import { findRepoRoot } from "./git.ts";
import { discardRecord } from "./history/discard.ts";
import { repoDir, repoIdFor, tasksDir } from "./paths.ts";
import { ensureServer, historyUrl } from "./server/launcher.ts";
import { readSessionMeta, updateSessionMeta } from "./session.ts";
import { readGraph, registerRepo } from "./tasks.ts";

const USAGE = `/flow on              start recording tasks in this project (add "project" for everyone)
/flow off             stop recording here
/flow forget          stop recording and delete everything fcc kept about this project
/flow                 open the development history of this project
/flow start "name"    group the next tasks under a feature
/flow end             stop grouping
/flow model [name]    show or set the model: sonnet, haiku, opus, a model id, or off
                      (add "project" to set it for this repository only)
/flow drop            delete the last task's report so it is never committed
/flow private         keep this session's tasks out of the repo (the last one is withdrawn)
/flow public          write this session's next tasks to the repo again`;

/** `fcc flow --session <id> --cwd <dir> [subcommand…]`, run by the /flow skill. Returns what to tell the user. */
export async function flowCommand(argv: string[]): Promise<string> {
  let session = "";
  let cwd = process.cwd();
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--session") session = argv[++i] ?? "";
    else if (argv[i] === "--cwd") cwd = argv[++i] ?? cwd;
    else words.push(argv[i]!);
  }
  const [sub = "", ...rest] = words;
  const needSession = () => {
    if (!session) throw new Error("no session id: run this through the /flow command in Claude Code");
  };

  switch (sub.toLowerCase()) {
    case "on":
    case "off": {
      const repoRoot = findRepoRoot(cwd);
      if (!repoRoot) return "fcc: this folder is not a git repository, so there is nothing to record.";
      const scope = rest.some((w) => /^(project|repo|--project)$/i.test(w)) ? "project" : "user";
      const on = sub.toLowerCase() === "on";
      const file = setProjectEnabled(repoRoot, on, scope);
      const who = scope === "project" ? "for everyone who has this repository" : "for you";
      return on
        ? `fcc: recording tasks in ${path.basename(repoRoot)} ${who} (${file}). The next task you run here gets a story.`
        : `fcc: no longer recording in ${path.basename(repoRoot)} ${who} (${file}). What it already recorded is kept; /flow forget deletes it.`;
    }
    case "forget": {
      const repoRoot = findRepoRoot(cwd);
      if (!repoRoot) return "fcc: this folder is not a git repository.";
      const { deleted } = forgetRepo(repoRoot);
      return `fcc: forgot ${path.basename(repoRoot)} — ${deleted} task(s) deleted and recording turned off. Reports already committed in the repository are untouched.`;
    }
    case "": {
      const repoRoot = findRepoRoot(cwd);
      if (!repoRoot) return "fcc: this folder is not a git repository, so there is no history to show.";
      if (!isProjectEnabled(repoRoot)) {
        return `fcc: not active in ${path.basename(repoRoot)}, so there is nothing recorded yet. Run /flow on to start.`;
      }
      const repoId = repoIdFor(repoRoot);
      registerRepo(repoId, repoRoot);
      const server = await ensureServer();
      if (!server) return "fcc: the viewer did not start (see ~/.claude/flow/fcc.log).";
      return `fcc: history of ${path.basename(repoRoot)} → ${historyUrl(server, repoId)}`;
    }
    case "start": {
      needSession();
      const name = rest.join(" ").trim();
      if (!name) return 'fcc: give the feature a name, e.g. /flow start "Discount codes".';
      updateSessionMeta(session, { feature: name });
      return `fcc: the next tasks of this session are grouped under "${name}" until /flow end.`;
    }
    case "end": {
      needSession();
      const { feature } = readSessionMeta(session);
      updateSessionMeta(session, { feature: undefined });
      return feature ? `fcc: closed the feature "${feature}".` : "fcc: no feature was open.";
    }
    case "model": {
      const repoRoot = findRepoRoot(cwd) ?? undefined;
      const scope = rest.some((w) => /^(project|repo|here|--project)$/i.test(w)) ? "project" : "user";
      const name = rest.filter((w) => !/^(project|repo|here|--project)$/i.test(w)).join(" ").trim();
      const current = readConfig(repoRoot);
      if (!name) {
        const from = configSource("model", repoRoot);
        const llmFrom = configSource("llm", repoRoot);
        const engine = current.llm === "api" ? "the Anthropic API" : "your Claude Code login";
        const state = current.llm === "off" ? `off (set at ${llmFrom} level)` : `${current.model} through ${engine} (set at ${from} level)`;
        return `fcc: stories are written with ${state}. Choose with: /flow model <${MODEL_CHOICES.join(" | ")} | claude-… | off>, adding "project" to set it for this repository only.`;
      }
      if (scope === "project" && !repoRoot) return "fcc: not inside a git repository, so there is no project to configure.";
      const lower = name.toLowerCase();
      if (lower === "off" || lower === "none") {
        const file = writeConfig(scope, { llm: "off" }, repoRoot);
        return `fcc: stories are off (${scope} setting, ${file}). Structure and history still work. Turn them back on with /flow model ${DEFAULT_CONFIG.model}.`;
      }
      if (!MODEL_CHOICES.includes(lower) && !lower.startsWith("claude-")) {
        return `fcc: unknown model "${name}". Use ${MODEL_CHOICES.join(", ")}, a full model id (claude-…), or off.`;
      }
      const file = writeConfig(scope, { model: lower, llm: current.llm === "off" ? "claude" : current.llm }, repoRoot);
      const envNote = configSource("model", repoRoot) === "env" ? " Note: FCC_MODEL is set in your environment and overrides this." : "";
      return `fcc: stories will be written with ${lower} (${scope} setting, ${file}).${envNote}`;
    }
    case "drop": {
      needSession();
      const meta = readSessionMeta(session);
      if (!meta.lastRepoId || !meta.lastTaskId) return "fcc: no task of this session to drop.";
      const result = discardRecord(meta.lastRepoId, meta.lastTaskId);
      return `fcc: ${result.message}`;
    }
    case "private": {
      needSession();
      const meta = updateSessionMeta(session, { private: true });
      return `fcc: this session is private: its tasks stay on this machine.${withdrawLast(session, meta.lastRepoId, meta.lastTaskId)}`;
    }
    case "public": {
      needSession();
      updateSessionMeta(session, { private: undefined });
      return "fcc: the next tasks of this session will be written to the repo history again.";
    }
    default:
      return `fcc: unknown option "${sub}".\n${USAGE}`;
  }
}

/** Delete everything fcc kept about a repository, and forget the decision. */
function forgetRepo(repoRoot: string): { deleted: number } {
  const repoId = repoIdFor(repoRoot);
  let deleted = 0;
  try {
    deleted = readdirSync(tasksDir(repoId)).length;
  } catch {
    deleted = 0;
  }
  rmSync(repoDir(repoId), { recursive: true, force: true });
  forgetProject(repoRoot);
  return { deleted };
}

/** Take the session's last task out of the repo, if its record was written. */
function withdrawLast(session: string, repoId?: string, taskId?: string): string {
  if (!repoId || !taskId) return "";
  const g = readGraph(repoId, taskId);
  if (!g || g.task.sessionId !== session) return "";
  const result = discardRecord(repoId, taskId);
  return result.recordPath
    ? ` Removed the last task's report (${result.recordPath}); if it was already committed, the removal shows up in git status.`
    : " The last task was marked private too.";
}
