import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { DEFAULT_CONFIG, readConfig, writeConfig } from "../src/config.ts";
import { flowCommand } from "../src/flow-command.ts";
import { llmSettings } from "../src/narrative/llm.ts";
import { FixtureRepo } from "./helpers.ts";

const home = mkdtempSync(path.join(tmpdir(), "fcc-home-"));
process.env.FCC_HOME = home;
const repos: FixtureRepo[] = [];
after(() => {
  repos.forEach((r) => r.cleanup());
  rmSync(home, { recursive: true, force: true });
});

function repo(): FixtureRepo {
  const r = new FixtureRepo({ "a.ts": "export const a = 1;\n" });
  repos.push(r);
  return r;
}

describe("choosing the model", () => {
  beforeEach(() => {
    rmSync(path.join(home, "config.json"), { force: true });
    delete process.env.FCC_MODEL;
    delete process.env.FCC_LLM;
  });

  test("the default is Sonnet through the Claude Code login", () => {
    assert.deepEqual(readConfig(), DEFAULT_CONFIG);
    assert.deepEqual(llmSettings(), { engine: "claude", model: "sonnet" });
  });

  test("/flow model sets it for every project", async () => {
    const out = await flowCommand(["--session", "s", "model", "haiku"]);
    assert.match(out, /haiku \(user setting/);
    assert.equal(readConfig().model, "haiku");
    assert.equal(llmSettings()?.model, "haiku");
  });

  test("a project setting wins over the user one", async () => {
    const r = repo();
    await flowCommand(["--session", "s", "model", "haiku"]);
    await flowCommand(["--session", "s", "--cwd", r.root, "model", "opus", "project"]);
    assert.equal(readConfig(r.root).model, "opus");
    assert.equal(readConfig().model, "haiku", "other projects keep the user setting");
    assert.equal(JSON.parse(readFileSync(path.join(r.root, ".claude/flow.json"), "utf8")).model, "opus");
  });

  test("the environment wins over both, and says so", async () => {
    const r = repo();
    await flowCommand(["--session", "s", "model", "haiku"]);
    process.env.FCC_MODEL = "claude-opus-5";
    assert.equal(readConfig(r.root).model, "claude-opus-5");
    const out = await flowCommand(["--session", "s", "--cwd", r.root, "model", "sonnet"]);
    assert.match(out, /FCC_MODEL is set in your environment and overrides this/);
  });

  test("off turns stories off, and a model turns them back on", async () => {
    assert.match(await flowCommand(["--session", "s", "model", "off"]), /stories are off/);
    assert.equal(llmSettings(), null);
    await flowCommand(["--session", "s", "model", "sonnet"]);
    assert.deepEqual(llmSettings(), { engine: "claude", model: "sonnet" });
  });

  test("a full model id is accepted, nonsense is refused", async () => {
    assert.match(await flowCommand(["--session", "s", "model", "claude-haiku-4-5"]), /claude-haiku-4-5/);
    assert.equal(readConfig().model, "claude-haiku-4-5");
    const bad = await flowCommand(["--session", "s", "model", "gpt-5"]);
    assert.match(bad, /unknown model/);
    assert.equal(readConfig().model, "claude-haiku-4-5", "the bad value is not written");
  });

  test("/flow model with no name reports what is in use", async () => {
    await flowCommand(["--session", "s", "model", "haiku"]);
    const out = await flowCommand(["--session", "s", "model"]);
    assert.match(out, /haiku through your Claude Code login \(set at user level\)/);
  });

  test("project scope outside a repository is refused", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fcc-nogit-"));
    assert.match(await flowCommand(["--session", "s", "--cwd", dir, "model", "haiku", "project"]), /not inside a git repository/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a hand-broken config file does not break fcc", () => {
    writeConfig("user", { model: "haiku" });
    const file = path.join(home, "config.json");
    writeFileSync(file, "{ not json");
    assert.deepEqual(readConfig(), DEFAULT_CONFIG);
  });
});
