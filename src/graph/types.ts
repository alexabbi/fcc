import type { ConversationEntry } from "../history/conversation.ts";
import type { Fingerprint } from "../history/fingerprint.ts";
import type { NarrativeState } from "../narrative/types.ts";

export type NodeStatus = "added" | "modified" | "removed" | "renamed" | "context";
export type EdgeStatus = "added" | "removed" | "unchanged";
export type EdgeKind = "call" | "new" | "render" | "ref";
export type SymbolKind = "function" | "method" | "class" | "variable" | "type" | "module";

/** Who changed a file during the task. */
export type Attribution = "claude" | "other";

export interface PackageNode {
  kind: "package";
  id: string;
  label: string;
  /** Repo-relative directory; "" for the repo root. */
  dir: string;
}

export interface FileNode {
  kind: "file";
  id: string;
  label: string;
  parent: string;
  path: string;
  oldPath?: string;
  status: NodeStatus;
  /** Absent on context files (unchanged, shown only to host neighbors). */
  attribution?: Attribution;
  /** true for files we did not parse (config, css, sql…): shown as a leaf. */
  opaque: boolean;
  /** Unified diff, only for opaque files. */
  diff?: string;
}

export interface SymbolNode {
  kind: "symbol";
  id: string;
  label: string;
  parent: string;
  path: string;
  symbolKind: SymbolKind;
  status: NodeStatus;
  /** 1-based line in the after version (before version for removed symbols). */
  line: number;
  /** Unified diff of just this symbol; absent for context nodes. */
  diff?: string;
}

export type FlowNode = PackageNode | FileNode | SymbolNode;

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  /** call: `f()`, new: `new C()`, render: `<C/>`, ref: passed around without being called here. */
  kind: EdgeKind;
  status: EdgeStatus;
}

export interface TaskInfo {
  id: string;
  repoId: string;
  repoRoot: string;
  sessionId: string;
  startedAt: string;
  endedAt: string;
  before: string;
  after: string;
  /** Repo-relative paths Claude wrote with Edit/Write/MultiEdit/NotebookEdit. */
  claudeFiles: string[];
  usedBash: boolean;
  /** Claude Code transcript, to rebuild the conversation behind the task (S13). */
  transcriptPath?: string;
  /** The conversation starts after this instant (end of the previous task of the session). */
  conversationSince?: string;
  /** Feature opened with `/flow start` (S14). */
  feature?: string;
  /** `/flow private`: never written to the repo (S10). */
  private?: boolean;
  /** HEAD when the task started. */
  baseCommit?: string;
}

export interface FlowGraph {
  version: 1;
  task: TaskInfo;
  status: "pending" | "ready" | "error";
  error?: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  warnings: string[];
  /** Levels 0–1; absent on graphs written before M2. */
  narrative?: NarrativeState;
  /**
   * Conversation behind the task, held only while the story is written and
   * then deleted: neither the repo nor the local cache keeps what you typed.
   */
  conversation?: ConversationEntry[];
  /** Line keys of the change, to find its commits later (S5). */
  fingerprint?: Fingerprint;
  /** Repo-relative path of the history record, once written (S6–S9). */
  recordPath?: string;
  stats?: {
    filesChanged: number;
    symbolsAdded: number;
    symbolsModified: number;
    symbolsRemoved: number;
    analysisMs: number;
  };
}
