import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { serverInfoPath } from "../paths.ts";
import { spawnSelfDetached } from "../spawn.ts";

export interface ServerInfo {
  port: number;
  token: string;
  pid: number;
}

export function readServerInfo(): ServerInfo | null {
  try {
    return JSON.parse(readFileSync(serverInfoPath(), "utf8"));
  } catch {
    return null;
  }
}

async function isAlive(info: ServerInfo): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/health`, {
      headers: { "x-fcc-token": info.token },
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Reuse the running server, or start one detached and wait for it to come up. */
export async function ensureServer(): Promise<ServerInfo | null> {
  const existing = readServerInfo();
  if (existing && (await isAlive(existing))) return existing;

  spawnSelfDetached(["serve"]);
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    const info = readServerInfo();
    if (info && info.pid !== existing?.pid && (await isAlive(info))) return info;
  }
  return null;
}

export function taskUrl(info: ServerInfo, repoId: string, taskId: string): string {
  return `http://127.0.0.1:${info.port}/?t=${info.token}#/${encodeURIComponent(repoId)}/${encodeURIComponent(taskId)}`;
}
