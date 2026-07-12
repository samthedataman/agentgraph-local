import { readFileSync, writeFileSync } from "node:fs";
import { getProcessExecutable, getProcessStartToken } from "./process-inspection.js";

export interface DaemonPidRecord {
  pid: number;
  processStartToken: string;
  executable: string;
}

export function currentDaemonPidRecord(): DaemonPidRecord {
  const processStartToken = getProcessStartToken(process.pid);
  const executable = getProcessExecutable(process.pid);
  if (!processStartToken || !executable) {
    throw new Error("Could not determine daemon process identity");
  }
  return { pid: process.pid, processStartToken, executable };
}

export function readDaemonPidRecord(path: string): DaemonPidRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DaemonPidRecord>;
    if (!Number.isInteger(parsed.pid) || Number(parsed.pid) <= 0) return null;
    if (typeof parsed.processStartToken !== "string" || !parsed.processStartToken) return null;
    if (typeof parsed.executable !== "string" || !parsed.executable) return null;
    return parsed as DaemonPidRecord;
  } catch {
    return null;
  }
}

export function daemonPidRecordMatches(record: DaemonPidRecord): boolean {
  return getProcessStartToken(record.pid) === record.processStartToken
    && getProcessExecutable(record.pid) === record.executable;
}

export function writeDaemonPidRecord(path: string, record = currentDaemonPidRecord()): void {
  writeFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
}
