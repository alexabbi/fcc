import picomatch from "picomatch";

/** Changed files matching these are left out of the graph entirely. */
export const DEFAULT_EXCLUDES = [
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/bun.lockb",
  "**/bun.lock",
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/.next/**",
  "**/.nx/**",
  "**/coverage/**",
  "**/__generated__/**",
  "**/*.generated.*",
  "**/*.min.js",
  "**/*.map",
  "**/*.snap",
];

/** Never loaded into the TS program, even as context. */
const PROGRAM_EXCLUDES = ["**/node_modules/**", "**/dist/**", "**/build/**", "**/out/**", "**/.next/**", "**/coverage/**", "**/*.min.js"];

const CODE_EXT = /\.(?:[cm]?tsx?|[cm]?jsx?)$/;

export function isCodeFile(path: string): boolean {
  return CODE_EXT.test(path);
}

export function makeMatcher(patterns: string[]): (path: string) => boolean {
  if (patterns.length === 0) return () => false;
  return picomatch(patterns, { dot: true });
}

export const isExcludedChange = makeMatcher(DEFAULT_EXCLUDES);
const isProgramExcluded = makeMatcher(PROGRAM_EXCLUDES);

export function isProgramFile(path: string): boolean {
  return isCodeFile(path) && !isProgramExcluded(path);
}
