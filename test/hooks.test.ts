import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { FlowGraph } from "../src/graph/types.ts";
import { repoIdFor } from "../src/paths.ts";
import { readGraph } from "../src/tasks.ts";
import { FixtureRepo } from "./helpers.ts";

const BIN = fileURLToPath(new URL("../bin/fcc.ts", import.meta.url));
const home = mkdtempSync(path.join(tmpdir(), "fcc-home-"));
process.env.FCC_HOME = home;
const repos: FixtureRepo[] = [];
after(() => {
  repos.forEach((r) => r.cleanup());
  rmSync(home, { recursive: true, force: true });
});

function hook(event: "prompt" | "tool" | "stop", input: object): string {
  const res = spawnSync(process.execPath, [BIN, "hook", event], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, FCC_HOME: home, FCC_SYNC: "1", FCC_NO_SERVER: "1", FCC_LLM: "off" },
  });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout;
}

function tasksOf(repo: FixtureRepo): FlowGraph[] {
  const repoId = repoIdFor(repo.root);
  let ids: string[];
  try {
    ids = readdirSync(path.join(home, "repos", repoId, "tasks"));
  } catch {
    return [];
  }
  return ids.map((id) => readGraph(repoId, id)!);
}

describe("hooks end to end", () => {
  let repo: FixtureRepo;
  let session = 0;
  beforeEach(() => {
    repo = new FixtureRepo({ "src/a.ts": "export function a() { return 1; }\n" });
    repos.push(repo);
    session++;
  });

  test("a task that edits a file produces a ready graph", () => {
    const base = { session_id: `s${session}`, cwd: repo.root };
    assert.equal(hook("prompt", { ...base, prompt: "make a return 2" }), "", "prompt hook must not print (stdout goes to context)");
    repo.write({ "src/a.ts": "export function a() { return b(); }\nexport function b() { return 2; }\n" });
    hook("tool", { ...base, tool_name: "Edit", tool_input: { file_path: "src/a.ts" } });
    // edited outside Claude's tools during the task:
    repo.write({ "notes.md": "hello\n" });
    hook("stop", base);

    const [g] = tasksOf(repo);
    assert.ok(g, "task recorded");
    assert.equal(g.status, "ready");
    assert.equal(g.task.prompt, "make a return 2");
    assert.deepEqual(g.task.claudeFiles, ["src/a.ts"]);
    const ids = g.nodes.map((n) => n.id);
    assert.ok(ids.includes("sym:src/a.ts#b"));
    const notes = g.nodes.find((n) => n.id === "file:notes.md");
    assert.equal(notes?.kind === "file" && notes.attribution, "other");
    // the real index is untouched (nothing staged); the history record waits in the work tree (S9)
    assert.deepEqual(repo.git("status", "--porcelain").split("\n").filter(Boolean).sort(), [" M src/a.ts", "?? docs/", "?? notes.md"]);
    assert.match(g.recordPath ?? "", /^docs\/flow\/\d{4}-\d{2}\/.+\.md$/);
  });

  test("a turn without tool calls produces nothing", () => {
    const base = { session_id: `s${session}`, cwd: repo.root };
    hook("prompt", { ...base, prompt: "explain a" });
    repo.write({ "src/a.ts": "export function a() { return 3; }\n" }); // the user editing meanwhile
    hook("stop", base);
    assert.equal(tasksOf(repo).length, 0);
  });

  test("a Bash-only turn with no changes produces nothing", () => {
    const base = { session_id: `s${session}`, cwd: repo.root };
    hook("prompt", { ...base, prompt: "run tests" });
    hook("tool", { ...base, tool_name: "Bash", tool_input: {} });
    hook("stop", base);
    assert.equal(tasksOf(repo).length, 0);
  });

  test("outside a git repo every hook is a silent no-op", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fcc-nogit-"));
    const base = { session_id: `s${session}`, cwd: dir };
    assert.equal(hook("prompt", { ...base, prompt: "x" }), "");
    assert.equal(hook("tool", { ...base, tool_name: "Write", tool_input: { file_path: "x.ts" } }), "");
    assert.equal(hook("stop", base), "");
    rmSync(dir, { recursive: true, force: true });
  });

  test("hooks are silent inside fcc's own headless session", () => {
    const base = { session_id: `s${session}`, cwd: repo.root };
    const res = spawnSync(process.execPath, [BIN, "hook", "prompt"], {
      input: JSON.stringify({ ...base, prompt: "x" }),
      encoding: "utf8",
      env: { ...process.env, FCC_HOME: home, FCC_DISABLE: "1" },
    });
    assert.equal(res.status, 0);
    repo.write({ "src/a.ts": "export function a() { return 9; }\n" });
    hook("tool", { ...base, tool_name: "Edit", tool_input: { file_path: "src/a.ts" } });
    hook("stop", base);
    assert.equal(tasksOf(repo).length, 0, "no task was started");
  });

  test("malformed input never fails the hook", () => {
    const res = spawnSync(process.execPath, [BIN, "hook", "stop"], { input: "not json", encoding: "utf8", env: { ...process.env, FCC_HOME: home } });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, "");
  });
});
