import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface RepositoryContext {
  repositoryRoot: string | null;
  worktreeRoot: string | null;
}

export function findRepositoryContext(cwd: string): RepositoryContext {
  let current = resolve(cwd);
  for (;;) {
    const marker = resolve(current, ".git");
    if (existsSync(marker)) {
      try {
        const stat = statSync(marker);
        return { repositoryRoot: current, worktreeRoot: current };
      } catch {
        return { repositoryRoot: current, worktreeRoot: current };
      }
    }
    const parent = dirname(current);
    if (parent === current) return { repositoryRoot: null, worktreeRoot: null };
    current = parent;
  }
}

