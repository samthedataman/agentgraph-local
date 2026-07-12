import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { AuthPrincipal, Authenticator } from "./types.js";

export interface TokenRecord {
  tokenId: string;
  salt: Buffer;
  tokenHash: Buffer;
  teamId: string;
  repositoryIds: string[];
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface TokenRecordSource {
  listActiveTokenRecords(nowIso: string): TokenRecord[];
}

export function hashBearerToken(token: string, salt: Buffer): Buffer {
  if (token.length < 24) throw new Error("remote bearer tokens must be at least 24 characters");
  return scryptSync(token, salt, 32, { N: 16_384, r: 8, p: 1 });
}

export function newTokenHash(token: string): { salt: Buffer; tokenHash: Buffer } {
  const salt = randomBytes(16);
  return { salt, tokenHash: hashBearerToken(token, salt) };
}

export class StoreAuthenticator implements Authenticator {
  constructor(private readonly source: TokenRecordSource) {}

  authenticate(token: string, nowMs: number): AuthPrincipal | null {
    if (!token || token.length > 4_096) return null;
    const records = this.source.listActiveTokenRecords(new Date(nowMs).toISOString());
    let match: TokenRecord | null = null;
    for (const candidate of records) {
      let candidateHash: Buffer;
      try {
        candidateHash = hashBearerToken(token, candidate.salt);
      } catch {
        candidateHash = Buffer.alloc(candidate.tokenHash.length);
      }
      const equal = candidateHash.length === candidate.tokenHash.length &&
        timingSafeEqual(candidateHash, candidate.tokenHash);
      if (equal && match === null) match = candidate;
    }
    return match === null ? null : {
      tokenId: match.tokenId,
      teamId: match.teamId,
      repositoryIds: [...match.repositoryIds]
    };
  }
}
