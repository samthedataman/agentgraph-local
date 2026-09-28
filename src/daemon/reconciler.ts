import type { Store } from "../store/store.js";
import { nowIso } from "../util/time.js";
import { processMatches } from "./process-inspection.js";

export interface ReconcileResult {
  checked: number;
  refreshed: number;
  stale: number;
  exited: number;
  idleDetached: number;
}

export type ProcessMatcher = (pid: number, processStartToken: string) => boolean;

export function reconcileLeases(
  store: Store,
  at = nowIso(),
  matches: ProcessMatcher = processMatches
): ReconcileResult {
  const result: ReconcileResult = { checked: 0, refreshed: 0, stale: 0, exited: 0, idleDetached: 0 };
  result.idleDetached = store.detachIdleHostedSessions(at);
  for (const presence of store.expiredProcesses(at)) {
    result.checked += 1;
    const sameProcess = matches(presence.pid, presence.processStartToken);
    if (!sameProcess) {
      store.markProcessState(presence.id, "exited", at);
      result.exited += 1;
    } else if (presence.mode === "attached") {
      store.touchAttachedProcess(presence.id, at);
      result.refreshed += 1;
    } else {
      store.markProcessState(presence.id, "stale", at);
      result.stale += 1;
    }
  }
  return result;
}

export class LeaseReconciler {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly store: Store, private readonly intervalMs: number) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => reconcileLeases(this.store), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
