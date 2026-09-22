import { existsSync } from "node:fs";
import path from "node:path";
import { findRepoRoot } from "./git.ts";
import { removeRecord } from "./history/record.ts";
import { repoIdFor } from "./paths.ts";
import { ensureServer, historyUrl } from "./server/launcher.ts";
import { readSessionMeta, updateSessionMeta } from "./session.ts";
import { readGraph, registerRepo, writeGraph } from "./tasks.ts";

const USAGE = `/flow                 open the development history of this project
/flow start "name"    group the next tasks under a feature
/flow end             stop grouping
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
    case "": {
      const repoRoot = findRepoRoot(cwd);
      if (!repoRoot) return "fcc: this folder is not a git repository, so there is no history to show.";
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

/** Take the session's last task out of the repo, if its record was written. */
function withdrawLast(session: string, repoId?: string, taskId?: string): string {
  if (!repoId || !taskId) return "";
  const g = readGraph(repoId, taskId);
  if (!g || g.task.sessionId !== session) return "";
  g.task.private = true;
  let note = "";
  if (g.recordPath) {
    if (existsSync(path.join(g.task.repoRoot, g.recordPath))) {
      removeRecord(g.task.repoRoot, g.recordPath);
      note = ` Removed the last task's record (${g.recordPath}); if it was already committed, the removal shows up in git status.`;
    }
    delete g.recordPath;
  }
  writeGraph(g);
  return note || " The last task was marked private too.";
}
