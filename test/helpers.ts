import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** A throwaway git repo for a test. */
export class FixtureRepo {
  readonly root: string;

  constructor(files: Record<string, string> = {}) {
    this.root = realpathSync(mkdtempSync(path.join(tmpdir(), "fcc-fixture-")));
    this.git("init", "-q");
    this.git("config", "user.email", "test@example.com");
    this.git("config", "user.name", "Test");
    this.git("config", "commit.gpgsign", "false");
    this.write(files);
    if (Object.keys(files).length > 0) this.commit("initial");
  }

  write(files: Record<string, string | null>): void {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(this.root, rel);
      if (content === null) {
        rmSync(abs, { force: true });
      } else {
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, content);
      }
    }
  }

  commit(message: string): void {
    this.git("add", "-A");
    this.git("commit", "-q", "-m", message);
  }

  git(...args: string[]): string {
    return execFileSync("git", args, { cwd: this.root, encoding: "utf8" });
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}
