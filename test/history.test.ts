import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { runAnalysis } from "../src/analysis-job.ts";
import { flowCommand } from "../src/flow-command.ts";
import { snapshotWorkTree } from "../src/git.ts";
import type { FlowGraph } from "../src/graph/types.ts";
import { readConversation } from "../src/history/conversation.ts";
import { readRecords } from "../src/history/record.ts";
import { buildHistory, recordToGraph } from "../src/history/timeline.ts";
import type { LlmRequest } from "../src/narrative/llm.ts";
import { buildInput } from "../src/narrative/prompt.ts";
import { readSessionMeta, updateSessionMeta } from "../src/session.ts";
import { readGraph, writeGraph } from "../src/tasks.ts";
import { FixtureRepo } from "./helpers.ts";

const home = mkdtempSync(path.join(tmpdir(), "fcc-home-"));
process.env.FCC_HOME = home;
const repos: FixtureRepo[] = [];
after(() => {
  repos.forEach((r) => r.cleanup());
  rmSync(home, { recursive: true, force: true });
});

let n = 0;
/** Write a transcript like Claude Code's: a grilling answer, a proposal, then "ok, go". */
function transcript(): string {
  const file = path.join(home, `t${n}.jsonl`);
  const lines = [
    { type: "user", timestamp: "2026-01-01T10:00:00Z", message: { role: "user", content: "<command-message>grilling</command-message><command-name>/grilling</command-name><command-args>add discounts to prices</command-args>" } },
    { type: "user", timestamp: "2026-01-01T10:00:01Z", isMeta: true, message: { role: "user", content: [{ type: "text", text: "SKILL BODY" }] } },
    { type: "assistant", timestamp: "2026-01-01T10:00:05Z", message: { role: "assistant", content: [{ type: "text", text: "Q1: flat 10% or per-customer rate? Recommend flat 10%." }] } },
    { type: "assistant", timestamp: "2026-01-01T10:00:06Z", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: {} }] } },
    { type: "user", timestamp: "2026-01-01T10:00:07Z", message: { role: "user", content: [{ type: "tool_result", content: "TOOL OUTPUT" }] } },
    { type: "user", timestamp: "2026-01-01T10:01:00Z", message: { role: "user", content: "accept, my SSN is 123-45-6789" } },
    { type: "user", timestamp: "2026-01-01T10:01:30Z", isSidechain: true, message: { role: "user", content: "subagent prompt" } },
    { type: "user", timestamp: "2026-01-01T10:02:00Z", message: { role: "user", content: "ok, go" } },
  ];
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

/** A pending task in a fresh repo: price() starts applying a discount. */
function pendingTask(opts: Partial<FlowGraph["task"]> = {}, repo?: FixtureRepo): { graph: FlowGraph; repo: FixtureRepo } {
  n++;
  if (!repo) {
    repo = new FixtureRepo({ "src/pricing.ts": "export function price(v: number) {\n  return v;\n}\n" });
    repos.push(repo);
  }
  const before = snapshotWorkTree(repo.root);
  repo.write({ "src/pricing.ts": `export function price(v: number) {\n  return applyDiscount(v, ${n});\n}\nexport function applyDiscount(value: number, pct${n}: number) {\n  return value * (1 - pct${n} / 100);\n}\n` });
  const graph: FlowGraph = {
    version: 1,
    task: {
      id: `2026010${n % 10}-10000${n % 10}-ab${String(n).padStart(2, "0")}`,
      repoId: `repo${repos.indexOf(repo)}`,
      repoRoot: repo.root,
      sessionId: "session-aaaa-bbbb",
      startedAt: "2000-01-01T00:00:00Z",
      endedAt: `2026-01-01T10:02:${String(n).padStart(2, "0")}Z`,
      before,
      after: snapshotWorkTree(repo.root),
      claudeFiles: ["src/pricing.ts"],
      usedBash: false,
      transcriptPath: transcript(),
      ...opts,
    },
    status: "pending",
    nodes: [],
    edges: [],
    warnings: [],
  };
  writeGraph(graph);
  return { graph, repo };
}

const fakeModel = async (req: LlmRequest) => {
  const input = JSON.parse(req.user);
  const ref = input.symbols.find((s: { name: string }) => s.name === "applyDiscount").ref;
  return {
    output: {
      intent: { goal: "Prices get a flat discount.", decisions: ["flat 10% rather than per-customer rates"], rejected: [] },
      headline: "Prices are now discounted",
      story: "Before, prices were returned as is. Now a discount is applied.",
      asks: [{ request: "Add discounts to prices", status: "done", note: "", anchors: [ref] }],
      verify: [{ priority: "high", text: "Rounding of discounted prices", anchors: [ref] }],
      flow: {
        title: "Pricing",
        steps: [
          { id: "t", label: "Price requested", detail: "", kind: "trigger", status: "unchanged", anchors: [] },
          { id: "d", label: 'Apply "discount"', detail: "", kind: "action", status: "added", anchors: [ref] },
        ],
        links: [{ from: "t", to: "d", label: "" }],
      },
    },
  };
};

describe("conversation (S13)", () => {
  test("keeps what the user typed and the agent's prose, nothing else", () => {
    const c = readConversation(transcript(), undefined, "2026-01-01T10:05:00Z");
    assert.deepEqual(
      c.map((e) => [e.role, e.text]),
      [
        ["user", "/grilling add discounts to prices"],
        ["assistant", "Q1: flat 10% or per-customer rate? Recommend flat 10%."],
        ["user", "accept, my SSN is 123-45-6789"],
        ["user", "ok, go"],
      ],
    );
  });

  test("starts after the previous task", () => {
    const c = readConversation(transcript(), "2026-01-01T10:01:00Z", "2026-01-01T10:05:00Z");
    assert.deepEqual(c.map((e) => e.text), ["ok, go"]);
  });

  test("the model sees the whole conversation, not just 'ok, go'", async () => {
    const { graph } = pendingTask();
    let seen = "";
    await runAnalysis(graph.task.repoId, graph.task.id, async (req) => ((seen = req.user), fakeModel(req)));
    const input = JSON.parse(seen);
    assert.equal(input.conversation[0].text, "/grilling add discounts to prices");
    assert.equal(input.conversation.at(-1).text, "ok, go");
    assert.equal(input.conversation[1].from, "agent");
  });
});

describe("history record in the repo (S6–S10)", () => {
  test("Markdown + JSON with the intent, and no trace of what the user typed", async () => {
    const { graph, repo } = pendingTask();
    const g = await runAnalysis(graph.task.repoId, graph.task.id, fakeModel);
    assert.match(g.recordPath!, /^docs\/flow\/2026-01\/.+-prices-are-now-discounted\.md$/);
    const md = readFileSync(path.join(repo.root, g.recordPath!), "utf8");
    assert.match(md, /^# Prices are now discounted$/m);
    assert.match(md, /flat 10% rather than per-customer rates/);
    assert.match(md, /```mermaid\nflowchart TD/);
    assert.match(md, /Apply #quot;discount#quot;/, "quotes escaped for Mermaid");
    const json = readFileSync(path.join(repo.root, g.recordPath!.replace(/\.md$/, ".json")), "utf8");
    for (const text of [md, json]) {
      assert.doesNotMatch(text, /123-45-6789/, "raw messages stay local");
      assert.doesNotMatch(text, /ok, go/);
      assert.doesNotMatch(text, new RegExp(repo.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "no absolute paths");
    }
    const cached = JSON.stringify(readGraph(graph.task.repoId, graph.task.id));
    assert.doesNotMatch(cached, /123-45-6789/, "…and not in the local cache either, once the story is written");
    assert.doesNotMatch(cached, /ok, go/);
    assert.ok(Object.keys(JSON.parse(json).fingerprint).includes("src/pricing.ts"));
  });

  test("a private task is not written to the repo", async () => {
    const { graph, repo } = pendingTask({ private: true });
    const g = await runAnalysis(graph.task.repoId, graph.task.id, fakeModel);
    assert.equal(g.recordPath, undefined);
    assert.equal(readRecords(repo.root).length, 0);
  });

  test("the next task does not see the previous record as a change", async () => {
    const first = pendingTask();
    await runAnalysis(first.graph.task.repoId, first.graph.task.id, fakeModel);
    const { graph } = pendingTask({}, first.repo);
    const g = await runAnalysis(graph.task.repoId, graph.task.id, fakeModel);
    assert.ok(!g.nodes.some((x) => x.kind === "file" && x.path.startsWith("docs/flow/")));
    assert.ok(buildInput(g).text.indexOf("docs/flow") === -1);
  });
});

describe("timeline (S11, S14)", () => {
  test("groups by feature, then by commit, then by session", async () => {
    const a = pendingTask({ feature: "Discounts" });
    await runAnalysis(a.graph.task.repoId, a.graph.task.id, fakeModel);
    const b = pendingTask({}, a.repo);
    await runAnalysis(b.graph.task.repoId, b.graph.task.id, fakeModel);
    a.repo.commit("Pricing work");
    const c = pendingTask({}, a.repo); // not committed
    await runAnalysis(c.graph.task.repoId, c.graph.task.id, fakeModel);

    const h = buildHistory(a.graph.task.repoId, a.repo.root);
    assert.equal(h.count, 3);
    const kinds = Object.fromEntries(h.groups.map((g) => [g.kind, g]));
    assert.equal(kinds.feature?.title, "Discounts");
    assert.equal(kinds.commit?.title, "Pricing work");
    assert.equal(kinds.session?.items[0]?.link.state, "uncommitted");
    assert.equal(kinds.commit?.items[0]?.link.state, "included", "task b was committed before task c touched the file");
  });

  test("a teammate's record (no local cache) opens as a story", async () => {
    const { graph, repo } = pendingTask();
    await runAnalysis(graph.task.repoId, graph.task.id, fakeModel);
    rmSync(path.join(home, "repos", graph.task.repoId), { recursive: true, force: true }); // as on another machine
    const h = buildHistory(graph.task.repoId, repo.root);
    assert.equal(h.groups[0]?.items[0]?.local, false);
    const g = recordToGraph(graph.task.repoId, repo.root, graph.task.id)!;
    assert.equal(g.narrative?.data?.headline, "Prices are now discounted");
    assert.ok(g.nodes.some((x) => x.id === "sym:src/pricing.ts#applyDiscount"));
  });
});

describe("/flow", () => {
  test("start/end name the feature of the next tasks", async () => {
    const s = "flow-session-1";
    assert.match(await flowCommand(["--session", s, "start", "Discount", "codes"]), /"Discount codes"/);
    assert.equal(readSessionMeta(s).feature, "Discount codes");
    assert.match(await flowCommand(["--session", s, "end"]), /closed/);
    assert.equal(readSessionMeta(s).feature, undefined);
  });

  test("private withdraws the last task's record and marks the session", async () => {
    const { graph, repo } = pendingTask({ sessionId: "flow-session-2" });
    const g = await runAnalysis(graph.task.repoId, graph.task.id, fakeModel);
    assert.ok(existsSync(path.join(repo.root, g.recordPath!)));
    updateSessionMeta("flow-session-2", { lastRepoId: graph.task.repoId, lastTaskId: graph.task.id });
    const out = await flowCommand(["--session", "flow-session-2", "private"]);
    assert.match(out, /Removed the last task's record/);
    assert.ok(!existsSync(path.join(repo.root, g.recordPath!)));
    assert.equal(readSessionMeta("flow-session-2").private, true);
    assert.equal(readGraph(graph.task.repoId, graph.task.id)?.task.private, true);
  });

  test("outside a repo, /flow explains instead of failing", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fcc-nogit-"));
    assert.match(await flowCommand(["--session", "x", "--cwd", dir]), /not a git repository/);
    rmSync(dir, { recursive: true, force: true });
  });
});
