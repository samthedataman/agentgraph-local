import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { FleetSafetyError } from "./errors.js";
import type { FleetArtifact, ResolvedFleetWorktree } from "./types.js";

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function encode(buffer: Buffer): Pick<FleetArtifact, "encoding" | "content"> {
  try {
    return { encoding: "utf8", content: new TextDecoder("utf-8", { fatal: true }).decode(buffer) };
  } catch {
    return { encoding: "base64", content: buffer.toString("base64") };
  }
}

export async function collectDeclaredArtifacts(
  worktree: ResolvedFleetWorktree,
  paths: string[],
  maxBytes: number
): Promise<FleetArtifact[]> {
  const root = await realpath(worktree.cwd);
  const artifacts: FleetArtifact[] = [];
  let captured = 0;
  for (const declaredPath of [...paths].sort()) {
    if (isAbsolute(declaredPath)) {
      throw new FleetSafetyError(`artifact path must be relative to its worktree: ${declaredPath}`);
    }
    const candidate = resolve(root, declaredPath);
    const canonical = await realpath(candidate).catch(() => {
      throw new FleetSafetyError(`declared artifact does not exist: ${declaredPath}`);
    });
    if (!isInside(root, canonical)) {
      throw new FleetSafetyError(`artifact escapes its worktree: ${declaredPath}`);
    }
    const linkDetails = await lstat(candidate);
    if (linkDetails.isSymbolicLink()) {
      throw new FleetSafetyError(`symbolic-link artifacts are not captured: ${declaredPath}`);
    }
    const details = await lstat(canonical);
    if (!details.isFile()) throw new FleetSafetyError(`artifact is not a regular file: ${declaredPath}`);
    if (details.size > maxBytes - captured) {
      throw new FleetSafetyError(
        `declared artifacts exceed task maxArtifactBytes ${maxBytes}; '${declaredPath}' is ${details.size} bytes`
      );
    }
    const remaining = maxBytes - captured;
    const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let buffer: Buffer;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== details.dev || opened.ino !== details.ino) {
        throw new FleetSafetyError(`declared artifact changed while being opened: ${declaredPath}`);
      }
      if (opened.size > maxBytes - captured) {
        throw new FleetSafetyError(
          `declared artifacts exceed task maxArtifactBytes ${maxBytes}; '${declaredPath}' is ${opened.size} bytes`
        );
      }
      const target = Buffer.alloc(remaining + 1);
      const { bytesRead } = await handle.read(target, 0, target.byteLength, 0);
      if (bytesRead > remaining) {
        throw new FleetSafetyError(
          `declared artifacts exceed task maxArtifactBytes ${maxBytes}; '${declaredPath}' grew while being captured`
        );
      }
      buffer = target.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    captured += buffer.byteLength;
    artifacts.push({
      path: declaredPath,
      sizeBytes: details.size,
      capturedBytes: buffer.byteLength,
      ...encode(buffer),
      sha256: createHash("sha256").update(buffer).digest("hex")
    });
  }
  return artifacts;
}
