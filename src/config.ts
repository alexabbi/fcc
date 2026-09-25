import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fccHome } from "./paths.ts";

/**
 * Settings, from the least to the most specific: built-in defaults, the user
 * file (`~/.claude/flow/config.json`), the project file
 * (`<repo>/.claude/flow.json`), then environment variables, which always win.
 */
export interface FccConfig {
  /** Set in a project file: fcc runs in this repository (and for everyone who has the file). */
  enabled?: boolean;
  /** "claude" (headless Claude Code, the default), "api" (Anthropic API) or "off". */
  llm: "claude" | "api" | "off";
  /** "sonnet" (default), "haiku", "opus", or a full model id. */
  model: string;
}

export const DEFAULT_CONFIG: FccConfig = { llm: "claude", model: "sonnet" };

/** Per-project decisions kept in the user file: repo path -> on/off. */
interface UserConfig extends FccConfig {
  projects?: Record<string, boolean>;
  /** Repos already told, once, that fcc is installed but asleep. */
  hinted?: string[];
}

/** Short names we accept; anything starting with `claude-` is passed through. */
export const MODEL_CHOICES = ["sonnet", "haiku", "opus"];

export type ConfigScope = "user" | "project";

export function userConfigPath(): string {
  return path.join(fccHome(), "config.json");
}

export function projectConfigPath(repoRoot: string): string {
  return path.join(repoRoot, ".claude", "flow.json");
}

/**
 * fcc does nothing in a repository until someone turns it on there: installing
 * the plugin must not start recording every project the developer opens.
 * A project file decides for everyone who has it; otherwise the developer's
 * own choice applies; with neither, the answer is no.
 */
export function isProjectEnabled(repoRoot: string): boolean {
  const project = readFile(projectConfigPath(repoRoot)).enabled;
  if (typeof project === "boolean") return project;
  const mine = (readFile(userConfigPath()) as UserConfig).projects?.[repoRoot];
  return typeof mine === "boolean" ? mine : false;
}

/** Has anyone decided about this repository yet, either way? */
export function hasDecision(repoRoot: string): boolean {
  if (typeof readFile(projectConfigPath(repoRoot)).enabled === "boolean") return true;
  return typeof (readFile(userConfigPath()) as UserConfig).projects?.[repoRoot] === "boolean";
}

export function setProjectEnabled(repoRoot: string, enabled: boolean, scope: ConfigScope): string {
  if (scope === "project") return writeConfig("project", { enabled }, repoRoot);
  const user = readFile(userConfigPath()) as UserConfig;
  return writeUserFile({ ...user, projects: { ...user.projects, [repoRoot]: enabled } });
}

/** Forget a project completely: the decision and the reminder about it. */
export function forgetProject(repoRoot: string): void {
  const user = readFile(userConfigPath()) as UserConfig;
  const projects = { ...user.projects };
  delete projects[repoRoot];
  writeUserFile({ ...user, projects, hinted: (user.hinted ?? []).filter((p) => p !== repoRoot) });
}

/**
 * True the first time a repository is seen, so the developer can be told once
 * that fcc is installed but asleep here — and never again.
 */
export function takeHint(repoRoot: string): boolean {
  const user = readFile(userConfigPath()) as UserConfig;
  if (user.hinted?.includes(repoRoot)) return false;
  writeUserFile({ ...user, hinted: [...(user.hinted ?? []), repoRoot] });
  return true;
}

export function readConfig(repoRoot?: string): FccConfig {
  const merged: FccConfig & { projects?: unknown; hinted?: unknown } = {
    ...DEFAULT_CONFIG,
    ...readFile(userConfigPath()),
    ...(repoRoot ? readFile(projectConfigPath(repoRoot)) : {}),
  };
  const env = process.env;
  if (env.FCC_LLM) merged.llm = normalizeLlm(env.FCC_LLM);
  if (env.FCC_MODEL) merged.model = env.FCC_MODEL;
  return { llm: normalizeLlm(merged.llm), model: String(merged.model || DEFAULT_CONFIG.model) };
}

/** Where a value comes from, to tell the user why their choice is being ignored. */
export function configSource(key: keyof FccConfig, repoRoot?: string): "env" | ConfigScope | "default" {
  if (process.env[key === "llm" ? "FCC_LLM" : "FCC_MODEL"]) return "env";
  if (repoRoot && readFile(projectConfigPath(repoRoot))[key] !== undefined) return "project";
  if (readFile(userConfigPath())[key] !== undefined) return "user";
  return "default";
}

export function writeConfig(scope: ConfigScope, patch: Partial<FccConfig>, repoRoot?: string): string {
  const file = scope === "project" ? projectConfigPath(repoRoot ?? process.cwd()) : userConfigPath();
  const next = { ...readFile(file), ...patch };
  for (const k of Object.keys(next) as (keyof FccConfig)[]) if (next[k] === undefined) delete next[k];
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  renameSync(tmp, file);
  return file;
}

function writeUserFile(value: UserConfig): string {
  const file = userConfigPath();
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, file);
  return file;
}

function readFile(file: string): Partial<UserConfig> {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {}; // missing, or hand-edited into invalid JSON: defaults still work
  }
}

function normalizeLlm(value: string): FccConfig["llm"] {
  const v = String(value).toLowerCase();
  if (v === "off" || v === "0" || v === "false" || v === "none") return "off";
  return v === "api" ? "api" : "claude";
}
