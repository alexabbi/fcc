import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { hasDecision, isProjectEnabled } from "../src/config.ts";
import { flowCommand } from "../src/flow-command.ts";
import { repoIdFor } from "../src/paths.ts";
import { listTasks } from "../src/tasks.ts";
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

/** A full turn: prompt, an edit, stop. */
function runTurn(repo: FixtureRepo, session: string): string {
  const base = { session_id: session, cwd: repo.root };
  const hint = hook("prompt", { ...base, prompt: "change a" });
  repo.write({ "src/a.ts": `export function a() { return ${Math.random()}; }\n` });
  hook("tool", { ...base, tool_name: "Edit", tool_input: { file_path: "src/a.ts" } });
  hook("stop", base);
  return hint;
}

const tasksOf = (repo: FixtureRepo) => listTasks().filter((t) => t.repoId === repoIdFor(repo.root));

describe("a project must be turned on first", () => {
  let repo: FixtureRepo;
  let session = 0;
  beforeEach(() => {
    repo = new FixtureRepo({ "src/a.ts": "export function a() { return 1; }\n" });
    repos.push(repo);
    session++;
  });

  test("an untouched project records nothing, and says so once", () => {
    assert.equal(isProjectEnabled(repo.root), false, "off until someone says otherwise");
    const first = runTurn(repo, `s${session}`);
    assert.match(first, /installed but not active/, "the developer is told, once");
    assert.equal(tasksOf(repo).length, 0, "and nothing is recorded");

    const second = runTurn(repo, `s${session}`);
    assert.equal(second, "", "never mentioned again for this project");
    assert.equal(tasksOf(repo).length, 0);
  });

  test("/flow on starts recording, /flow off stops it", async () => {
    runTurn(repo, `s${session}`); // uses up the hint
    assert.match(await flowCommand(["--session", "x", "--cwd", repo.root, "on"]), /recording tasks in/);
    assert.equal(isProjectEnabled(repo.root), true);

    runTurn(repo, `s${session}`);
    assert.equal(tasksOf(repo).length, 1, "the task is recorded now");

    await flowCommand(["--session", "x", "--cwd", repo.root, "off"]);
    runTurn(repo, `s${session}`);
    assert.equal(tasksOf(repo).length, 1, "and nothing more after that");
  });

  test("a project file turns it on for everyone, and wins over a personal no", async () => {
    await flowCommand(["--session", "x", "--cwd", repo.root, "off"]);
    await flowCommand(["--session", "x", "--cwd", repo.root, "on", "project"]);
    assert.equal(JSON.parse(readFileSync(path.join(repo.root, ".claude/flow.json"), "utf8")).enabled, true);
    assert.equal(isProjectEnabled(repo.root), true, "the repository has the last word");
  });

  test("/flow in a project that is off explains how to start", async () => {
    assert.match(await flowCommand(["--session", "x", "--cwd", repo.root]), /not active in .*\/flow on/s);
  });

  test("/flow forget deletes what was recorded and the decision itself", async () => {
    await flowCommand(["--session", "x", "--cwd", repo.root, "on"]);
    runTurn(repo, `s${session}`);
    assert.equal(tasksOf(repo).length, 1);

    const out = await flowCommand(["--session", "x", "--cwd", repo.root, "forget"]);
    assert.match(out, /1 task\(s\) deleted/);
    assert.equal(tasksOf(repo).length, 0);
    assert.equal(isProjectEnabled(repo.root), false);
    assert.equal(hasDecision(repo.root), false, "back to never having been asked");
    assert.ok(existsSync(repo.root), "the repository itself is untouched");
  });
});
