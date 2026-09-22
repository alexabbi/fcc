import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { snapshotWorkTree } from "../src/git.ts";
import { analyzeTask, type AnalysisResult } from "../src/graph/analyze.ts";
import type { FileNode, FlowEdge, SymbolNode, TaskInfo } from "../src/graph/types.ts";
import { FixtureRepo } from "./helpers.ts";

const repos: FixtureRepo[] = [];
after(() => repos.forEach((r) => r.cleanup()));

/** Snapshot, apply `changes`, snapshot again, analyze. */
function run(initial: Record<string, string>, changes: Record<string, string | null>, claudeFiles?: string[]): AnalysisResult {
  const repo = new FixtureRepo(initial);
  repos.push(repo);
  const before = snapshotWorkTree(repo.root);
  repo.write(changes);
  const afterTree = snapshotWorkTree(repo.root);
  const task: TaskInfo = {
    id: "t",
    repoId: "r",
    repoRoot: repo.root,
    sessionId: "s",
    prompt: "",
    startedAt: "",
    endedAt: "",
    before,
    after: afterTree,
    claudeFiles: claudeFiles ?? Object.keys(changes),
    usedBash: false,
  };
  return analyzeTask(task);
}

const sym = (r: AnalysisResult, id: string) => r.nodes.find((n) => n.id === `sym:${id}`) as SymbolNode | undefined;
const file = (r: AnalysisResult, p: string) => r.nodes.find((n) => n.id === `file:${p}`) as FileNode | undefined;
const edge = (r: AnalysisResult, from: string, to: string) =>
  r.edges.find((e) => e.id === `sym:${from}->sym:${to}`) as FlowEdge | undefined;

const BASE = {
  "package.json": JSON.stringify({ name: "shop" }),
  "src/cart.ts": [
    'import { price } from "./pricing";',
    "",
    "export function total(items: string[]): number {",
    "  return items.reduce((sum, i) => sum + price(i), 0);",
    "}",
    "",
  ].join("\n"),
  "src/pricing.ts": ["export function price(item: string): number {", "  return item.length;", "}", ""].join("\n"),
  "src/checkout.ts": [
    'import { total } from "./cart";',
    "",
    "export function checkout(items: string[]) {",
    "  return { amount: total(items) };",
    "}",
    "",
  ].join("\n"),
};

describe("analyzeTask", () => {
  test("added function wired into an existing caller", () => {
    const r = run(BASE, {
      "src/pricing.ts": [
        "export function price(item: string): number {",
        "  return applyDiscount(item.length);",
        "}",
        "",
        "export function applyDiscount(amount: number): number {",
        "  return amount * 0.9;",
        "}",
        "",
      ].join("\n"),
    });

    assert.equal(sym(r, "src/pricing.ts#applyDiscount")?.status, "added");
    assert.equal(sym(r, "src/pricing.ts#price")?.status, "modified");
    assert.equal(edge(r, "src/pricing.ts#price", "src/pricing.ts#applyDiscount")?.status, "added");
    // 1-hop context: the unchanged caller of `price`
    assert.equal(sym(r, "src/cart.ts#total")?.status, "context");
    assert.equal(edge(r, "src/cart.ts#total", "src/pricing.ts#price")?.status, "unchanged");
    // 2 hops away: not shown
    assert.equal(sym(r, "src/checkout.ts#checkout"), undefined);
    assert.equal(file(r, "src/pricing.ts")?.attribution, "claude");
    assert.equal(file(r, "src/cart.ts")?.status, "context");
    assert.equal(file(r, "src/pricing.ts")?.parent, "pkg:");
  });

  test("removed function and removed call", () => {
    const r = run(BASE, {
      "src/cart.ts": ["export function total(items: string[]): number {", "  return items.length;", "}", ""].join("\n"),
      "src/pricing.ts": null,
    });

    assert.equal(sym(r, "src/pricing.ts#price")?.status, "removed");
    assert.equal(file(r, "src/pricing.ts")?.status, "removed");
    assert.equal(edge(r, "src/cart.ts#total", "src/pricing.ts#price")?.status, "removed");
    assert.match(sym(r, "src/pricing.ts#price")?.diff ?? "", /^-export function price/m);
  });

  test("class members, constructors and JSX renders", () => {
    const r = run(
      {
        "src/store.ts": [
          "export class Store {",
          "  items: string[] = [];",
          "  add(item: string) { this.items.push(item); }",
          "}",
          "",
        ].join("\n"),
        "src/App.tsx": [
          'import { Store } from "./store";',
          "export function Item(props: { name: string }) { return <li>{props.name}</li>; }",
          "export function App() {",
          "  const s = new Store();",
          '  s.add("a");',
          "  return <ul>{s.items.map((i) => <Item name={i} />)}</ul>;",
          "}",
          "",
        ].join("\n"),
      },
      {
        "src/store.ts": [
          "export class Store {",
          "  items: string[] = [];",
          "  constructor() { this.log('init'); }",
          "  add(item: string) { this.log(item); this.items.push(item); }",
          "  log(msg: string) { console.log(msg); }",
          "}",
          "",
        ].join("\n"),
      },
    );

    assert.equal(sym(r, "src/store.ts#Store.add")?.status, "modified");
    assert.equal(sym(r, "src/store.ts#Store.log")?.status, "added");
    assert.equal(sym(r, "src/store.ts#Store.constructor")?.status, "added");
    assert.equal(sym(r, "src/store.ts#Store"), undefined, "class shell unchanged");
    assert.equal(edge(r, "src/store.ts#Store.add", "src/store.ts#Store.log")?.status, "added");
    assert.equal(edge(r, "src/App.tsx#App", "src/store.ts#Store.add")?.kind, "call");
    assert.equal(edge(r, "src/App.tsx#App", "src/store.ts#Store.constructor")?.kind, "new");
    assert.equal(sym(r, "src/App.tsx#Item"), undefined, "render edge not touching a change");
  });

  test("renamed file keeps symbol identity", () => {
    const r = run(BASE, { "src/pricing.ts": null, "src/prices.ts": BASE["src/pricing.ts"], "src/cart.ts": BASE["src/cart.ts"].replace("./pricing", "./prices") });
    const f = file(r, "src/prices.ts");
    assert.equal(f?.status, "renamed");
    assert.equal(f?.oldPath, "src/pricing.ts");
    assert.equal(sym(r, "src/prices.ts#price"), undefined, "content unchanged: no symbol change");
    assert.equal(sym(r, "src/cart.ts#(module)"), undefined, "import changes are not a symbol change");
  });

  test("non-code files are opaque nodes, lockfiles excluded, attribution", () => {
    const r = run(BASE, {
      "db/001_init.sql": "create table t (id int);\n",
      "package-lock.json": "{}\n",
      "src/cart.ts": BASE["src/cart.ts"] + "export const TAX = 0.2;\n",
    }, ["src/cart.ts"]);
    const sql = file(r, "db/001_init.sql");
    assert.equal(sql?.opaque, true);
    assert.equal(sql?.attribution, "other");
    assert.match(sql?.diff ?? "", /create table/);
    assert.equal(file(r, "package-lock.json"), undefined);
    assert.equal(sym(r, "src/cart.ts#TAX")?.symbolKind, "variable");
    assert.ok(r.warnings.some((w) => w.includes("exclude")));
  });

  test("package clusters from nearest package.json", () => {
    const r = run(
      {
        "package.json": JSON.stringify({ name: "root" }),
        "packages/ui/package.json": JSON.stringify({ name: "@acme/ui" }),
        "packages/ui/src/button.ts": "export function button() { return 1; }\n",
      },
      { "packages/ui/src/button.ts": "export function button() { return 2; }\n" },
    );
    const pkg = r.nodes.find((n) => n.id === "pkg:packages/ui");
    assert.equal(pkg?.label, "@acme/ui");
    assert.equal(file(r, "packages/ui/src/button.ts")?.parent, "pkg:packages/ui");
  });

  test("Nx project.json marks a cluster", () => {
    const r = run(
      {
        "package.json": JSON.stringify({ name: "root" }),
        "libs/cart/project.json": JSON.stringify({ name: "cart-lib" }),
        "libs/cart/src/index.ts": "export function cart() { return 1; }\n",
      },
      { "libs/cart/src/index.ts": "export function cart() { return 2; }\n" },
    );
    assert.equal(file(r, "libs/cart/src/index.ts")?.parent, "pkg:libs/cart");
    assert.equal(r.nodes.find((n) => n.id === "pkg:libs/cart")?.label, "cart-lib");
  });

  test("tsconfig paths aliases resolve across files", () => {
    const r = run(
      {
        "tsconfig.json": '{ "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["lib/*"] } } // comment\n}',
        "lib/math.ts": "export function sq(n: number) { return n * n; }\n",
        "app/main.ts": 'import { sq } from "@lib/math";\nexport function main() { return sq(3); }\n',
      },
      { "lib/math.ts": "export function sq(n: number) { return n ** 2; }\n" },
    );
    assert.equal(sym(r, "lib/math.ts#sq")?.status, "modified");
    assert.equal(edge(r, "app/main.ts#main", "lib/math.ts#sq")?.status, "unchanged");
  });
});
