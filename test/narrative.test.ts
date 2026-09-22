import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { runAnalysis } from "../src/analysis-job.ts";
import { snapshotWorkTree } from "../src/git.ts";
import type { FlowGraph } from "../src/graph/types.ts";
import type { LlmRequest } from "../src/narrative/llm.ts";
import { buildInput } from "../src/narrative/prompt.ts";
import { validateNarrative } from "../src/narrative/validate.ts";
import { readGraph, writeGraph } from "../src/tasks.ts";
import { FixtureRepo } from "./helpers.ts";

const home = mkdtempSync(path.join(tmpdir(), "fcc-home-"));
process.env.FCC_HOME = home;
const repos: FixtureRepo[] = [];
after(() => {
  repos.forEach((r) => r.cleanup());
  rmSync(home, { recursive: true, force: true });
});

/** A pending task: price() now calls a new applyDiscount(), plus an external SQL file. */
function pendingTask(): FlowGraph {
  const repo = new FixtureRepo({
    "src/pricing.ts": "export function price(n: number) { return n; }\n",
    "src/cart.ts": 'import { price } from "./pricing";\nexport function total(xs: number[]) { return xs.map(price); }\n',
  });
  repos.push(repo);
  const before = snapshotWorkTree(repo.root);
  repo.write({
    "src/pricing.ts": "export function price(n: number) { return applyDiscount(n); }\nexport function applyDiscount(n: number) { return n * 0.9; }\n",
    "db/1.sql": "alter table t add c int;\n",
  });
  const graph: FlowGraph = {
    version: 1,
    task: {
      id: `t${repos.length}`,
      repoId: "r",
      repoRoot: repo.root,
      sessionId: "s",
      prompt: "Apply a 10% discount to prices",
      startedAt: "",
      endedAt: "",
      before,
      after: snapshotWorkTree(repo.root),
      claudeFiles: ["src/pricing.ts"],
      usedBash: true,
    },
    status: "pending",
    nodes: [],
    edges: [],
    warnings: [],
  };
  writeGraph(graph);
  return graph;
}

/** Canned model output, written against the refs the model would see. */
function fakeOutput(refs: Map<string, string>) {
  const ref = (id: string) => [...refs].find(([, v]) => v === id)![0];
  return {
    headline: "Prices are now discounted by 10%",
    story: "Before, prices were passed through. Now every price is discounted.",
    asks: [{ request: "Apply a 10% discount", status: "done", note: "via applyDiscount", anchors: [ref("sym:src/pricing.ts#applyDiscount"), "s999"] }],
    verify: [{ priority: "high", text: "SQL written outside the agent", anchors: [ref("file:db/1.sql")] }],
    flow: {
      title: "Pricing",
      steps: [
        { id: "t", label: "Cart totals prices", detail: "", kind: "trigger", status: "unchanged", anchors: [] },
        { id: "a", label: "Compute price", detail: "", kind: "action", status: "modified", anchors: [ref("sym:src/pricing.ts#price")] },
        { id: "b", label: "Apply discount", detail: "", kind: "action", status: "added", anchors: [ref("sym:src/pricing.ts#applyDiscount")] },
        { id: "c", label: "Write the SQL", detail: "", kind: "action", status: "added", anchors: [ref("file:db/1.sql")] },
        { id: "d", label: "Invented step", detail: "", kind: "action", status: "added", anchors: ["s999"] },
        { id: "a", label: "duplicate id", detail: "", kind: "action", status: "added", anchors: [] },
      ],
      links: [
        { from: "t", to: "a", label: "" },
        { from: "a", to: "b", label: "" },
        { from: "b", to: "c", label: "then" },
        { from: "c", to: "nowhere", label: "" },
      ],
    },
  };
}

describe("narrative", () => {
  test("input uses short refs and only valid refs are allowed in anchors", async () => {
    const g = await runAnalysisWith(pendingTask(), "off");
    const input = buildInput(g);
    assert.ok(input.text.includes('"ref": "s1"'));
    assert.ok(!input.text.includes("sym:"), "graph ids are not sent to the model");
    assert.ok(input.text.includes("external (shell command"), "attribution is visible to the model");
    assert.equal([...input.refs.values()].filter((v) => v.startsWith("file:")).length, 2);
  });

  test("validation maps refs back, drops unknown anchors and grades links", async () => {
    const g = await runAnalysisWith(pendingTask(), "off");
    const input = buildInput(g);
    const { narrative, checks } = validateNarrative(fakeOutput(input.refs), input.refs, g);

    assert.deepEqual(narrative.asks[0]!.anchors, ["sym:src/pricing.ts#applyDiscount"]);
    assert.equal(checks.droppedAnchors, 2); // s999 in the ask and in step d
    assert.equal(checks.unanchoredSteps, 1); // step d
    assert.deepEqual(narrative.flow.steps.map((s) => s.id), ["t", "a", "b", "c", "d"], "duplicate id dropped");
    const link = (from: string, to: string) => narrative.flow.links.find((l) => l.from === from && l.to === to);
    assert.equal(link("t", "a")?.grounded, true, "trigger has no code to contradict");
    assert.equal(link("a", "b")?.grounded, true, "price calls applyDiscount");
    assert.equal(link("b", "c")?.grounded, false, "no code path from pricing to the SQL file");
    assert.equal(link("c", "nowhere"), undefined);
    assert.equal(checks.inferredLinks, 1);
  });

  test("the job writes the static graph, then the narrative", async () => {
    const task = pendingTask();
    const seen: string[] = [];
    const g = await runAnalysis(task.task.repoId, task.task.id, async (req: LlmRequest) => {
      // while the model runs, the page already has the static graph
      const mid = readGraph(task.task.repoId, task.task.id)!;
      seen.push(`${mid.status}/${mid.narrative?.status}`);
      assert.equal(req.model, "sonnet");
      assert.ok(req.system.length > 100);
      return { output: fakeOutput(buildInput(mid).refs), costUsd: 0.01 };
    });
    assert.deepEqual(seen, ["ready/pending"]);
    assert.equal(g.narrative?.status, "ready");
    assert.equal(g.narrative?.data?.headline, "Prices are now discounted by 10%");
    assert.equal(g.narrative?.costUsd, 0.01);
    assert.equal(readGraph(task.task.repoId, task.task.id)?.narrative?.status, "ready");
  });

  test("a failing model leaves the static graph usable", async () => {
    const task = pendingTask();
    const g = await runAnalysis(task.task.repoId, task.task.id, async () => {
      throw new Error("rate limited");
    });
    assert.equal(g.status, "ready");
    assert.ok(g.nodes.length > 0);
    assert.equal(g.narrative?.status, "error");
    assert.equal(g.narrative?.error, "rate limited");
  });

  test("FCC_LLM=off skips the narrative", async () => {
    const g = await runAnalysisWith(pendingTask(), "off");
    assert.equal(g.narrative?.status, "off");
  });
});

async function runAnalysisWith(task: FlowGraph, llm: string): Promise<FlowGraph> {
  const prev = process.env.FCC_LLM;
  process.env.FCC_LLM = llm;
  try {
    return await runAnalysis(task.task.repoId, task.task.id);
  } finally {
    if (prev === undefined) delete process.env.FCC_LLM;
    else process.env.FCC_LLM = prev;
  }
}
