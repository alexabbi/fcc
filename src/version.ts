import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The plugin's own version, read from its manifest next to the entry point
 * (`dist/fcc.mjs` when bundled, `bin/fcc.ts` from source). Used to notice
 * that the viewer still running belongs to an older copy of the plugin.
 */
export const VERSION: string = readVersion();

function readVersion(): string {
  try {
    const manifest = path.join(path.dirname(path.dirname(process.argv[1]!)), ".claude-plugin", "plugin.json");
    return String(JSON.parse(readFileSync(manifest, "utf8")).version ?? "unknown");
  } catch {
    return "unknown";
  }
}
