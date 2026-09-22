import { spawn } from "node:child_process";

/**
 * Run another fcc command in the background, outliving the hook.
 * Re-executes the current entry point (bin/fcc.ts in dev, dist/fcc.mjs when
 * bundled) with the same Node binary.
 */
export function spawnSelfDetached(args: string[]): void {
  const child = spawn(process.execPath, [process.argv[1]!, ...args], { detached: true, stdio: "ignore" });
  child.unref();
}
