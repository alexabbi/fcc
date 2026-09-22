import path from "node:path";
import { structuredPatch } from "diff";
import { ts } from "ts-morph";
import { diffTrees, fileDiff, listTree, readBlobs, type FileChange, type TreeEntry } from "../git.ts";
import { historyDir } from "../history/record.ts";
import { isCodeFile, isExcludedChange, isProgramFile } from "./filters.ts";
import { CodeVersion, type SymbolEdge, type SymbolInfo } from "./symbols.ts";
import type { EdgeKind, FileNode, FlowEdge, FlowGraph, FlowNode, NodeStatus, PackageNode, SymbolNode, TaskInfo } from "./types.ts";

/** Above this many code files, only the packages containing changes are loaded. */
const MAX_PROGRAM_FILES = 6000;
const MAX_DIFF_LINES = 400;
const MAX_FILE_DIFFS = 150;

export type AnalysisResult = Pick<FlowGraph, "nodes" | "edges" | "warnings" | "stats">;

export function analyzeTask(task: TaskInfo): AnalysisResult {
  const t0 = Date.now();
  const { repoRoot, before, after } = task;
  const warnings: string[] = [];
  const claudeFiles = new Set(task.claudeFiles);

  // fcc's own history records are written while the next task may be running (S9).
  const ownDir = `${historyDir()}/`;
  const allChanges = diffTrees(repoRoot, before, after).filter((c) => !c.path.startsWith(ownDir));
  const changes = allChanges.filter((c) => !isExcludedChange(c.path));
  if (allChanges.length > changes.length) {
    warnings.push(`${allChanges.length - changes.length} file(s) hidden by exclude patterns (lockfiles, build output, generated files).`);
  }

  const afterEntries = listTree(repoRoot, after);
  const beforeEntries = listTree(repoRoot, before);
  const packages = new PackageResolver(repoRoot, afterEntries, beforeEntries);

  const codeChanges = changes.filter((c) => isCodeFile(c.path) || (c.oldPath !== undefined && isCodeFile(c.oldPath)));
  const renamedTo = new Map(changes.filter((c) => c.oldPath).map((c) => [c.oldPath!, c.path]));
  /** Before-version ids use old paths; express everything in after-version ids. */
  const toAfterId = (id: string) => {
    const hash = id.indexOf("#");
    const p = id.slice(0, hash);
    return (renamedTo.get(p) ?? p) + id.slice(hash);
  };

  const nodes = new Map<string, FlowNode>();
  const edges = new Map<string, FlowEdge>();
  let added = 0, modified = 0, removed = 0;

  const ensureFile = (filePath: string, status: NodeStatus, change?: FileChange, opaque = false): FileNode => {
    const id = fileNodeId(filePath);
    const existing = nodes.get(id);
    if (existing?.kind === "file") return existing;
    const pkg = packages.packageFor(filePath);
    nodes.set(pkg.id, pkg);
    const node: FileNode = {
      kind: "file",
      id,
      label: path.posix.basename(filePath),
      parent: pkg.id,
      path: filePath,
      status,
      opaque,
    };
    if (change) {
      node.attribution = claudeFiles.has(change.path) || (change.oldPath !== undefined && claudeFiles.has(change.oldPath)) ? "claude" : "other";
      if (change.oldPath) node.oldPath = change.oldPath;
    }
    nodes.set(id, node);
    return node;
  };

  // Changed files first, so every changed file shows up even when no symbol changed.
  let diffsLeft = MAX_FILE_DIFFS;
  for (const change of changes) {
    const node = ensureFile(change.path, fileStatus(change), change, !codeChanges.includes(change));
    if (diffsLeft-- > 0) node.diff = truncate(fileDiff(repoRoot, before, after, change));
  }
  if (changes.length > MAX_FILE_DIFFS) warnings.push(`File diffs shown only for the first ${MAX_FILE_DIFFS} files.`);

  if (codeChanges.length > 0) {
    const changedPaths = new Set(codeChanges.flatMap((c) => (c.oldPath ? [c.path, c.oldPath] : [c.path])));
    const compilerOptions = readCompilerOptions(repoRoot, afterEntries, warnings);
    const afterFiles = selectProgramFiles(afterEntries, changedPaths, packages, warnings);
    const beforeFiles = selectProgramFiles(beforeEntries, changedPaths, packages, []);
    const blobs = readBlobs(repoRoot, [...afterFiles, ...beforeFiles].map((e) => e.sha));
    const vAfter = new CodeVersion(toFileMap(afterFiles, blobs), compilerOptions);
    const vBefore = new CodeVersion(toFileMap(beforeFiles, blobs), compilerOptions);

    // 1. Which symbols changed, in after-version id space.
    const changed = new Map<string, { before?: SymbolInfo; after?: SymbolInfo }>();
    for (const c of codeChanges) {
      const afterSyms = c.status === "D" || !vAfter.hasFile(c.path) ? [] : vAfter.symbolsOf(c.path);
      const beforePath = c.oldPath ?? c.path;
      const beforeSyms = c.status === "A" || !vBefore.hasFile(beforePath) ? [] : vBefore.symbolsOf(beforePath);
      const pairs = new Map<string, { before?: SymbolInfo; after?: SymbolInfo }>();
      for (const s of afterSyms) pairs.set(s.id, { after: s });
      for (const s of beforeSyms) {
        const id = toAfterId(s.id);
        pairs.set(id, { ...pairs.get(id), before: s });
      }
      for (const [id, pair] of pairs) {
        if (pair.before && pair.after && pair.before.text === pair.after.text) continue;
        changed.set(id, pair);
      }
    }

    // 2. Edges touching a changed symbol, in both versions.
    const presence = new Map<string, { edge: SymbolEdge; before: boolean; after: boolean }>();
    const collect = (list: SymbolEdge[], side: "before" | "after") => {
      for (const e of list) {
        const edge = side === "before" ? { ...e, source: toAfterId(e.source), target: toAfterId(e.target) } : e;
        const key = `${edge.source}->${edge.target}`;
        const entry = presence.get(key) ?? { edge, before: false, after: false };
        entry[side] = true;
        if (KIND_RANK[edge.kind] > KIND_RANK[entry.edge.kind]) entry.edge = edge;
        presence.set(key, entry);
      }
    };
    for (const [, pair] of changed) {
      if (pair.after) collect([...vAfter.outgoing(pair.after.id), ...vAfter.incoming(pair.after.id)], "after");
      if (pair.before) collect([...vBefore.outgoing(pair.before.id), ...vBefore.incoming(pair.before.id)], "before");
    }

    // 3. Nodes: changed symbols, then unchanged neighbors as context.
    for (const [id, pair] of changed) {
      const info = (pair.after ?? pair.before)!;
      const status: NodeStatus = !pair.before ? "added" : !pair.after ? "removed" : "modified";
      if (status === "added") added++;
      else if (status === "removed") removed++;
      else modified++;
      const filePath = id.slice(0, id.indexOf("#"));
      ensureFile(filePath, "context");
      const node: SymbolNode = {
        kind: "symbol",
        id: symbolNodeId(id),
        label: info.name,
        parent: fileNodeId(filePath),
        path: filePath,
        symbolKind: info.kind,
        status,
        line: info.line,
        diff: symbolDiff(filePath, pair.before, pair.after),
      };
      nodes.set(node.id, node);
    }
    const beforeIdsByAfterId = new Map<string, string>();
    for (const [key] of presence) {
      for (const id of key.split("->")) {
        if (nodes.has(symbolNodeId(id))) continue;
        const info = vAfter.symbols.get(id) ?? findBeforeSymbol(vBefore, id, toAfterId, beforeIdsByAfterId);
        if (!info) continue;
        const filePath = id.slice(0, id.indexOf("#"));
        ensureFile(filePath, "context");
        nodes.set(symbolNodeId(id), {
          kind: "symbol",
          id: symbolNodeId(id),
          label: info.name,
          parent: fileNodeId(filePath),
          path: filePath,
          symbolKind: info.kind,
          status: "context",
          line: info.line,
        });
      }
    }
    for (const [, { edge, before: b, after: a }] of presence) {
      const source = symbolNodeId(edge.source);
      const target = symbolNodeId(edge.target);
      if (!nodes.has(source) || !nodes.has(target)) continue;
      const id = `${source}->${target}`;
      edges.set(id, { id, source, target, kind: edge.kind, status: a && b ? "unchanged" : a ? "added" : "removed" });
    }
  }

  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    warnings,
    stats: {
      filesChanged: changes.length,
      symbolsAdded: added,
      symbolsModified: modified,
      symbolsRemoved: removed,
      analysisMs: Date.now() - t0,
    },
  };
}

const KIND_RANK: Record<EdgeKind, number> = { ref: 0, render: 1, new: 2, call: 3 };

export function fileNodeId(p: string): string {
  return `file:${p}`;
}

export function symbolNodeId(id: string): string {
  return `sym:${id}`;
}

function fileStatus(c: FileChange): NodeStatus {
  return c.status === "A" ? "added" : c.status === "D" ? "removed" : c.status === "R" ? "renamed" : "modified";
}

function findBeforeSymbol(
  v: CodeVersion,
  afterId: string,
  toAfterId: (id: string) => string,
  cache: Map<string, string>,
): SymbolInfo | undefined {
  if (cache.size === 0) for (const id of v.symbols.keys()) cache.set(toAfterId(id), id);
  const beforeId = cache.get(afterId);
  return beforeId ? v.symbols.get(beforeId) : undefined;
}

function symbolDiff(filePath: string, before?: SymbolInfo, after?: SymbolInfo): string {
  // Symbol texts carry no trailing newline; add one so the patch has no "\ No newline" noise.
  const text = (s?: SymbolInfo) => (s ? s.text + "\n" : "");
  const patch = structuredPatch(filePath, filePath, text(before), text(after), "", "", { context: 3 });
  const oldOffset = before ? before.line - 1 : 0;
  const newOffset = after ? after.line - 1 : 0;
  const lines: string[] = [];
  for (const h of patch.hunks) {
    const oldStart = h.oldLines === 0 ? 0 : h.oldStart + oldOffset;
    const newStart = h.newLines === 0 ? 0 : h.newStart + newOffset;
    lines.push(`@@ -${oldStart},${h.oldLines} +${newStart},${h.newLines} @@`, ...h.lines);
  }
  return truncate(lines.join("\n"));
}

function truncate(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= MAX_DIFF_LINES) return text;
  return lines.slice(0, MAX_DIFF_LINES).join("\n") + `\n… ${lines.length - MAX_DIFF_LINES} more lines`;
}

function toFileMap(entries: TreeEntry[], blobs: Map<string, string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of entries) {
    const text = blobs.get(e.sha);
    if (text !== undefined) map.set(e.path, text);
  }
  return map;
}

function selectProgramFiles(
  entries: TreeEntry[],
  changedPaths: Set<string>,
  packages: PackageResolver,
  warnings: string[],
): TreeEntry[] {
  const code = entries.filter((e) => isProgramFile(e.path));
  if (code.length <= MAX_PROGRAM_FILES) return code;
  const pkgs = new Set([...changedPaths].map((p) => packages.packageFor(p).dir));
  const scoped = code.filter((e) => pkgs.has(packages.packageFor(e.path).dir) || changedPaths.has(e.path));
  warnings.push(
    `Large repo (${code.length} code files): references are only resolved inside the ${pkgs.size} changed package(s).`,
  );
  if (scoped.length <= MAX_PROGRAM_FILES) return scoped;
  warnings.push(`Still ${scoped.length} files after scoping; analysis truncated to ${MAX_PROGRAM_FILES}.`);
  const mustKeep = scoped.filter((e) => changedPaths.has(e.path));
  const rest = scoped.filter((e) => !changedPaths.has(e.path));
  return [...mustKeep, ...rest.slice(0, MAX_PROGRAM_FILES - mustKeep.length)];
}

/** Compiler options from the root tsconfig (paths/baseUrl matter for resolving imports). */
function readCompilerOptions(repoRoot: string, entries: TreeEntry[], warnings: string[]): ts.CompilerOptions {
  const entry = ["tsconfig.base.json", "tsconfig.json"].map((n) => entries.find((e) => e.path === n)).find(Boolean);
  if (!entry) return {};
  const text = readBlobs(repoRoot, [entry.sha]).get(entry.sha) ?? "";
  const parsed = ts.parseConfigFileTextToJson(entry.path, text);
  if (parsed.error) {
    warnings.push(`Could not parse ${entry.path}; using default compiler options.`);
    return {};
  }
  const { options } = ts.convertCompilerOptionsFromJson(parsed.config?.compilerOptions ?? {}, "/");
  // Output-only and environment options are irrelevant (or harmful) in memory.
  delete options.outDir;
  delete options.rootDir;
  delete options.composite;
  delete options.incremental;
  delete options.tsBuildInfoFile;
  delete options.typeRoots;
  delete options.plugins;
  return options;
}

const MANIFESTS = new Set(["package.json", "project.json"]);

/** Nearest directory with a package.json (or Nx project.json) is a node's cluster. */
class PackageResolver {
  private readonly dirs: Set<string>;
  private readonly names = new Map<string, string>();
  private readonly cache = new Map<string, PackageNode>();
  private readonly repoName: string;

  constructor(repoRoot: string, ...trees: TreeEntry[][]) {
    this.repoName = path.basename(repoRoot);
    const manifests = new Map<string, TreeEntry>();
    for (const tree of trees) {
      for (const e of tree) {
        if (MANIFESTS.has(path.posix.basename(e.path)) && !e.path.includes("node_modules/")) {
          const dir = path.posix.dirname(e.path);
          // project.json wins: its name is the Nx project name
          if (!manifests.has(dir) || e.path.endsWith("project.json")) manifests.set(dir, e);
        }
      }
    }
    this.dirs = new Set([...manifests.keys()].map((d) => (d === "." ? "" : d)));
    this.dirs.add("");
    const blobs = readBlobs(repoRoot, [...manifests.values()].map((e) => e.sha));
    for (const [dir, e] of manifests) {
      try {
        const name = JSON.parse(blobs.get(e.sha) ?? "{}").name;
        if (typeof name === "string") this.names.set(dir === "." ? "" : dir, name);
      } catch {
        // malformed package.json: fall back to the directory name
      }
    }
  }

  packageFor(filePath: string): PackageNode {
    let dir = path.posix.dirname(filePath);
    if (dir === ".") dir = "";
    while (dir !== "" && !this.dirs.has(dir)) {
      const up = path.posix.dirname(dir);
      dir = up === "." ? "" : up;
    }
    let node = this.cache.get(dir);
    if (!node) {
      node = { kind: "package", id: `pkg:${dir}`, dir, label: this.names.get(dir) ?? (dir || this.repoName) };
      this.cache.set(dir, node);
    }
    return node;
  }
}
