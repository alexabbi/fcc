import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { execFileSync } from "node:child_process";
import { snapshotWorkTree } from "../src/git.ts";
import { linkTask, loadCommits } from "../src/history/commits.ts";
import { fingerprintFromDiff, type Fingerprint } from "../src/history/fingerprint.ts";
import { FixtureRepo } from "./helpers.ts";

const repos: FixtureRepo[] = [];
after(() => repos.forEach((r) => r.cleanup()));

const START = "2000-01-01T00:00:00Z";

/** A repo on `main`, and a task that adds a discount function to pricing.ts. */
function setup(): { repo: FixtureRepo; fp: Fingerprint } {
  const repo = new FixtureRepo({ "src/pricing.ts": "export function price(n: number) {\n  return n;\n}\n" });
  repos.push(repo);
  repo.git("branch", "-M", "main");
  const before = snapshotWorkTree(repo.root);
  repo.write({
    "src/pricing.ts": [
      "export function price(n: number) {",
      "  return applyDiscount(n);",
      "}",
      "",
      "export function applyDiscount(amount: number): number {",
      "  const rate = currentRate();",
      "  return Math.round(amount * (1 - rate) * 100) / 100;",
      "}",
      "",
    ].join("\n"),
  });
  const afterTree = snapshotWorkTree(repo.root);
  const diff = execFileSync("git", ["diff", before, afterTree], { cwd: repo.root, encoding: "utf8" });
  return { repo, fp: fingerprintFromDiff(diff) };
}

const link = (repo: FixtureRepo, fp: Fingerprint) => linkTask(repo.root, fp, START, loadCommits(repo.root, START));

describe("linking tasks to commits", () => {
  test("fingerprint keeps meaningful lines only", () => {
    const { fp } = setup();
    const f = fp["src/pricing.ts"]!;
    assert.equal(f.add.length, 4, "return applyDiscount, the signature, const rate, the return");
    assert.equal(f.del.length, 1, "return n");
  });

  test("uncommitted while the change sits in the working tree", () => {
    const { repo, fp } = setup();
    assert.equal(link(repo, fp).state, "uncommitted");
  });

  test("included in the commit that contains it", () => {
    const { repo, fp } = setup();
    repo.commit("Add discounts");
    const l = link(repo, fp);
    assert.equal(l.state, "included");
    assert.equal(l.commits[0]?.subject, "Add discounts");
  });

  test("survives a squash of several commits", () => {
    const { repo, fp } = setup();
    repo.git("checkout", "-q", "-b", "feature");
    repo.commit("wip 1");
    repo.write({ "README.md": "docs\n" });
    repo.commit("wip 2");
    repo.git("checkout", "-q", "main");
    repo.git("merge", "-q", "--squash", "feature");
    repo.git("commit", "-q", "-m", "Discounts (squashed)");
    const l = link(repo, fp);
    assert.equal(l.state, "included");
    assert.deepEqual(l.commits.map((c) => c.subject), ["Discounts (squashed)"]);
  });

  test("survives a rebase (new commit ids, same content)", () => {
    const { repo, fp } = setup();
    repo.git("checkout", "-q", "-b", "feature");
    repo.commit("Add discounts");
    repo.git("checkout", "-q", "main");
    repo.write({ "other.ts": "export const other = 1;\n" });
    repo.commit("Unrelated work on main");
    repo.git("checkout", "-q", "feature");
    repo.git("rebase", "-q", "main");
    const l = link(repo, fp);
    assert.equal(l.state, "included");
    assert.equal(l.commits[0]?.subject, "Add discounts");
  });

  test("partial when part of the change was rewritten before committing", () => {
    const { repo, fp } = setup();
    repo.write({
      "src/pricing.ts": [
        "export function price(n: number) {",
        "  return applyDiscount(n);",
        "}",
        "",
        "export function applyDiscount(value: number): number {",
        "  return value * 0.9;",
        "}",
        "",
      ].join("\n"),
    });
    repo.commit("Simpler discounts");
    assert.equal(link(repo, fp).state, "partial");
  });

  test("discarded when the change was thrown away", () => {
    const { repo, fp } = setup();
    repo.git("checkout", "--", ".");
    const l = link(repo, fp);
    assert.equal(l.state, "discarded");
    assert.deepEqual(l.commits, []);
  });

  test("a removed SQL comment is a removed line, not a diff header", () => {
    const fp = fingerprintFromDiff(
      ["diff --git a/db.sql b/db.sql", "--- a/db.sql", "+++ b/db.sql", "@@ -1,2 +1 @@", "--- old migration note", " select 1;"].join("\n"),
    );
    assert.equal(fp["db.sql"]?.del.length, 1);
    assert.equal(fp["old migration note"], undefined);
  });
});
