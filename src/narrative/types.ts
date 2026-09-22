/** Levels 0–1: the plain-language account of a task, anchored to graph node ids. */

export type AskStatus = "done" | "partial" | "missing";
export type Priority = "high" | "medium" | "low";
export type StepKind = "trigger" | "action" | "decision" | "data" | "outcome";
export type StepStatus = "added" | "modified" | "removed" | "unchanged";

export interface Ask {
  request: string;
  status: AskStatus;
  note: string;
  /** Graph node ids (sym:… / file:…). */
  anchors: string[];
}

export interface VerifyItem {
  priority: Priority;
  text: string;
  anchors: string[];
}

export interface FlowStep {
  id: string;
  label: string;
  detail: string;
  kind: StepKind;
  status: StepStatus;
  anchors: string[];
}

export interface FlowLink {
  from: string;
  to: string;
  label?: string;
  /** The code behind the two steps is connected in the call graph. */
  grounded: boolean;
}

export interface Narrative {
  headline: string;
  story: string;
  asks: Ask[];
  verify: VerifyItem[];
  flow: { title: string; steps: FlowStep[]; links: FlowLink[] };
}

export interface NarrativeChecks {
  /** Anchors the model returned that do not exist in the graph. */
  droppedAnchors: number;
  /** Steps (other than trigger/outcome) left without any anchor. */
  unanchoredSteps: number;
  groundedLinks: number;
  inferredLinks: number;
}

export type Engine = "claude" | "api";

export interface NarrativeState {
  status: "pending" | "ready" | "error" | "off";
  engine?: Engine;
  model?: string;
  seconds?: number;
  costUsd?: number;
  error?: string;
  /** Input was trimmed to fit the budget. */
  trimmed?: boolean;
  checks?: NarrativeChecks;
  data?: Narrative;
}
