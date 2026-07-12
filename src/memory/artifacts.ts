import { id, sha256, stableJson } from "../util/ids.js";
import { nowIso } from "../util/time.js";
import type { SqliteDatabase } from "./database.js";
import { ensureDomainSchema } from "./schema.js";
import type { Artifact, ArtifactInput, MemoryScope, Sensitivity } from "./types.js";
import { parseJsonObject } from "./validation.js";

interface ArtifactRow {
  artifact_id: string;
  name: string;
  scope_kind: MemoryScope["kind"];
  scope_key: string;
  media_type: string;
  sha256: string;
  byte_length: number;
  content_ref: string;
  inline_content: string | null;
  source_session_id: string | null;
  source_event_id: string | null;
  sensitivity: Sensitivity;
  metadata_json: string;
  created_at: string;
}

export class ArtifactStore {
  constructor(
    readonly database: SqliteDatabase,
    private readonly clock: () => string = nowIso,
    private readonly maxInlineBytes = 256 * 1024
  ) {
    ensureDomainSchema(database);
  }

  publish(input: ArtifactInput): Artifact {
    if (!input.name.trim()) throw new Error("Artifact name is required");
    if (input.content === undefined && !input.contentRef) {
      throw new Error("Artifact content or contentRef is required");
    }
    const bytes = input.content === undefined ? 0 : Buffer.byteLength(input.content, "utf8");
    if (bytes > this.maxInlineBytes) {
      throw new Error(`Inline artifact content exceeds ${this.maxInlineBytes} bytes; publish a contentRef instead`);
    }
    const digest = sha256(input.content ?? stableJson({ contentRef: input.contentRef, metadata: input.metadata ?? {} }));
    const artifactId = id("artifact");
    const contentRef = input.contentRef ?? `agentgraph://artifacts/${artifactId}/content`;
    this.database
      .prepare(
        `INSERT INTO ag_artifacts(
          artifact_id, name, scope_kind, scope_key, media_type, sha256, byte_length,
          content_ref, inline_content, source_session_id, source_event_id, sensitivity,
          metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        artifactId,
        input.name.trim(),
        input.scope.kind,
        input.scope.key,
        input.mediaType ?? "text/plain",
        digest,
        bytes,
        contentRef,
        input.content ?? null,
        input.sourceSessionId ?? null,
        input.sourceEventId ?? null,
        input.sensitivity ?? "private",
        JSON.stringify(input.metadata ?? {}),
        this.clock()
      );
    const artifact = this.get(artifactId, true);
    if (!artifact) throw new Error("Failed to read newly published artifact");
    return artifact;
  }

  get(artifactId: string, includeContent = false): Artifact | null {
    const row = this.database.prepare("SELECT * FROM ag_artifacts WHERE artifact_id = ?").get(artifactId) as
      | ArtifactRow
      | undefined;
    if (!row) return null;
    const artifact: Artifact = {
      id: row.artifact_id,
      name: row.name,
      scope: { kind: row.scope_kind, key: row.scope_key },
      mediaType: row.media_type,
      sha256: row.sha256,
      byteLength: row.byte_length,
      contentRef: row.content_ref,
      sourceSessionId: row.source_session_id,
      sourceEventId: row.source_event_id,
      sensitivity: row.sensitivity,
      metadata: parseJsonObject(row.metadata_json),
      createdAt: row.created_at
    };
    return includeContent && row.inline_content !== null ? { ...artifact, content: row.inline_content } : artifact;
  }

  list(scope: MemoryScope, limit = 20): Artifact[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM ag_artifacts WHERE scope_kind = ? AND scope_key = ?
         ORDER BY created_at DESC LIMIT ?`
      )
      .all(scope.kind, scope.key, Math.min(Math.max(limit, 1), 100)) as ArtifactRow[];
    return rows.map((row) => this.get(row.artifact_id, false)).filter((item): item is Artifact => item !== null);
  }
}

