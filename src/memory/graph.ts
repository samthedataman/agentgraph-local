import { id } from "../util/ids.js";
import { nowIso } from "../util/time.js";
import type { SqliteDatabase } from "./database.js";
import { ensureDomainSchema } from "./schema.js";
import type { GraphEdge, GraphEdgeInput, GraphNode, GraphNodeInput, MemoryScope } from "./types.js";
import { boundedNumber, parseJsonObject } from "./validation.js";

interface NodeRow {
  node_id: string;
  node_type: string;
  canonical_key: string;
  label: string;
  scope_kind: MemoryScope["kind"];
  scope_key: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

interface EdgeRow {
  edge_id: string;
  from_node_id: string;
  to_node_id: string;
  edge_type: string;
  evidence_event_id: string | null;
  confidence: number;
  valid_from: string;
  valid_until: string | null;
  metadata_json: string;
}

export interface GraphNeighborhood {
  center: GraphNode;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export class GraphStore {
  constructor(
    readonly database: SqliteDatabase,
    private readonly clock: () => string = nowIso
  ) {
    ensureDomainSchema(database);
  }

  upsertNode(input: GraphNodeInput): GraphNode {
    if (!input.type.trim() || !input.canonicalKey.trim() || !input.label.trim()) {
      throw new Error("Graph node type, canonicalKey, and label are required");
    }
    const timestamp = this.clock();
    const nodeId = input.id ?? id("node");
    this.database
      .prepare(
        `INSERT INTO ag_graph_nodes(
          node_id, node_type, canonical_key, label, scope_kind, scope_key,
          metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_kind, scope_key, node_type, canonical_key) DO UPDATE SET
          label = excluded.label,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at`
      )
      .run(
        nodeId,
        input.type,
        input.canonicalKey,
        input.label,
        input.scope.kind,
        input.scope.key,
        JSON.stringify(input.metadata ?? {}),
        timestamp,
        timestamp
      );
    const row = this.database
      .prepare(
        "SELECT * FROM ag_graph_nodes WHERE scope_kind = ? AND scope_key = ? AND node_type = ? AND canonical_key = ?"
      )
      .get(input.scope.kind, input.scope.key, input.type, input.canonicalKey) as NodeRow | undefined;
    if (!row) throw new Error("Failed to read graph node after upsert");
    return mapNode(row);
  }

  getNode(nodeId: string): GraphNode | null {
    const row = this.database.prepare("SELECT * FROM ag_graph_nodes WHERE node_id = ?").get(nodeId) as
      | NodeRow
      | undefined;
    return row ? mapNode(row) : null;
  }

  addEdge(input: GraphEdgeInput): GraphEdge {
    if (!input.type.trim()) throw new Error("Graph edge type is required");
    if (!this.getNode(input.fromNodeId) || !this.getNode(input.toNodeId)) {
      throw new Error("Both graph edge endpoints must exist");
    }
    const edgeId = input.id ?? id("edge");
    const validFrom = input.validFrom ?? this.clock();
    const confidence = boundedNumber(input.confidence, "confidence", 0.8);
    const existing = this.database
      .prepare(
        `SELECT * FROM ag_graph_edges
         WHERE from_node_id = ? AND to_node_id = ? AND edge_type = ?
           AND evidence_event_id IS ?`
      )
      .get(input.fromNodeId, input.toNodeId, input.type, input.evidenceEventId ?? null) as EdgeRow | undefined;
    if (existing) {
      this.database
        .prepare(
          `UPDATE ag_graph_edges SET confidence = ?, valid_until = ?, metadata_json = ?
           WHERE edge_id = ?`
        )
        .run(confidence, input.validUntil ?? null, JSON.stringify(input.metadata ?? {}), existing.edge_id);
      const updated = this.database.prepare("SELECT * FROM ag_graph_edges WHERE edge_id = ?").get(existing.edge_id) as EdgeRow;
      return mapEdge(updated);
    }
    this.database
      .prepare(
        `INSERT INTO ag_graph_edges(
          edge_id, from_node_id, to_node_id, edge_type, evidence_event_id,
          confidence, valid_from, valid_until, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        edgeId,
        input.fromNodeId,
        input.toNodeId,
        input.type,
        input.evidenceEventId ?? null,
        confidence,
        validFrom,
        input.validUntil ?? null,
        JSON.stringify(input.metadata ?? {})
      );
    const row = this.database
      .prepare(
        `SELECT * FROM ag_graph_edges
         WHERE from_node_id = ? AND to_node_id = ? AND edge_type = ?
           AND evidence_event_id IS ?`
      )
      .get(input.fromNodeId, input.toNodeId, input.type, input.evidenceEventId ?? null) as EdgeRow | undefined;
    if (!row) throw new Error("Failed to read graph edge after insert");
    return mapEdge(row);
  }

  neighbors(nodeId: string, options: { direction?: "in" | "out" | "both"; edgeTypes?: string[]; limit?: number } = {}): GraphNeighborhood {
    const center = this.getNode(nodeId);
    if (!center) throw new Error(`Graph node not found: ${nodeId}`);
    const direction = options.direction ?? "both";
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 250);
    const directionSql =
      direction === "in"
        ? "e.to_node_id = ?"
        : direction === "out"
          ? "e.from_node_id = ?"
          : "(e.from_node_id = ? OR e.to_node_id = ?)";
    const edgeTypeSql = options.edgeTypes?.length
      ? ` AND e.edge_type IN (${options.edgeTypes.map(() => "?").join(",")})`
      : "";
    const idParams = direction === "both" ? [nodeId, nodeId] : [nodeId];
    const rows = this.database
      .prepare(
        `SELECT e.* FROM ag_graph_edges e
         WHERE ${directionSql}${edgeTypeSql}
           AND (e.valid_until IS NULL OR e.valid_until > ?)
         ORDER BY e.valid_from DESC LIMIT ?`
      )
      .all(...idParams, ...(options.edgeTypes ?? []), this.clock(), limit) as EdgeRow[];
    const edges = rows.map(mapEdge);
    const nodeIds = new Set<string>();
    for (const edge of edges) {
      if (edge.fromNodeId !== nodeId) nodeIds.add(edge.fromNodeId);
      if (edge.toNodeId !== nodeId) nodeIds.add(edge.toNodeId);
    }
    const nodes = [...nodeIds].map((candidate) => this.getNode(candidate)).filter((node): node is GraphNode => node !== null);
    return { center, nodes, edges };
  }
}

function mapNode(row: NodeRow): GraphNode {
  return {
    id: row.node_id,
    type: row.node_type,
    canonicalKey: row.canonical_key,
    label: row.label,
    scope: { kind: row.scope_kind, key: row.scope_key },
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapEdge(row: EdgeRow): GraphEdge {
  return {
    id: row.edge_id,
    fromNodeId: row.from_node_id,
    toNodeId: row.to_node_id,
    type: row.edge_type,
    evidenceEventId: row.evidence_event_id,
    confidence: row.confidence,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    metadata: parseJsonObject(row.metadata_json)
  };
}
