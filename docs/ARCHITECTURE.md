# Architecture

## Invariants

1. A terminal, process, provider conversation, turn, and subagent are distinct identities.
2. Process leases determine liveness; hooks enrich semantic state.
3. The event log is canonical; memory and graph tables are rebuildable projections.
4. The daemon is the only SQLite writer.
5. Agent-facing access uses a focused MCP server over stdio.
6. Ordinary interactive sessions receive durable next-turn messages unless a supported managed delivery channel exists.
7. Peer content never becomes privileged instruction text merely because another model produced it.
8. A fleet is an explicit root-authored DAG; managed workers cannot add descendants to it.
9. Concurrent writer access is worktree-owned, dependency-ordered, and protected by a process-identity lease.
10. Remote synchronization moves memory records only. The remote hub never executes an agent or exposes the local daemon.

## Components

### CLI wrapper

`agentgraph codex`, `agentgraph claude`, and `agentgraph run` register a process, inherit the terminal, start the real binary without a shell, maintain a lease, and report its exit.

### Hooks

Codex and Claude command hooks send short lifecycle envelopes to the daemon. They correlate the provider-native session and turn IDs with `AGENTGRAPH_RUN_ID`. Hooks spool events to disk if the daemon is unavailable.

### Daemon

The daemon listens on an owner-only Unix socket. It performs migrations, process reconciliation, event sequencing, state projection, memory queries, and handoff state transitions.

### Store

SQLite runs in WAL mode. Operational tables represent hosts, terminals, processes, sessions, attachments, turns, subagents, and events. Domain tables represent memories, graph edges, artifacts, and handoffs.

### MCP proxy

Each agent host launches its own stdio MCP process. The process inherits caller correlation data and forwards operations to the daemon rather than opening a competing writable database connection.

### Managed adapters

Provider adapters normalize Codex JSONL, Claude stream-JSON, and Kimi Code stream-JSON into AgentGraph events. They preserve native session identifiers and do not add provider permission-bypass flags. Because Kimi's documented non-interactive mode uses its automatic permission policy, its adapter requires an explicit caller opt-in.

The runner launches without a shell, bounds captured JSONL records, and on POSIX places each provider CLI in its own process group so cancellation reaches descendants. Codex and Kimi are time/output bounded but do not claim unsupported hard turn or USD guarantees.

### Fleet coordinator

`agentgraph fleet validate` parses a versioned task plan, rejects unknown fields and cyclic or over-limit graphs, resolves each task to a worktree, and prints deterministic execution waves. Missing automatic worktrees are returned as quoted preparation commands for the developer to review and run manually.

`agentgraph fleet run` requires the explicit `run` verb. It schedules dependency-ready tasks up to the root concurrency bound, forwards completed dependency results as explicitly untrusted evidence, propagates cancellation, captures declared artifacts, and aggregates deterministic task results. A writer acquires an exclusive lease keyed to worktree ownership. Tasks sharing a worktree with writer access must be dependency-ordered.

Fleet worktrees are isolation boundaries for coordination, not OS-level filesystem sandboxes. Provider-native sandboxes and approvals remain authoritative. AgentGraph does not create merges, pushes, or releases.

### Remote team-memory sync

Remote sync is a separate opt-in subsystem:

1. A local memory-mutation outbox records repository memory changes, including deletions and supersessions.
2. The sync client atomically stages idempotent records in a private checkpoint file.
3. An authenticated HTTPS hub stores an append-only, team/repository-scoped log in a separate SQLite database.
4. Clients long-poll monotonic cursors and import records into their own local daemon through normal memory RPC.

The hub stamps authenticated token identity onto records. Local bindings are keyed by authenticated actor plus remote subject, so a different actor cannot tombstone or supersede them. Secret memory is rejected at every export/protocol boundary, private memory requires explicit sharing, and imported peer text is marked as untrusted provenance-bearing context. The hub sees synchronized plaintext and is not an end-to-end-encrypted store.

### A2A façade

The experimental loopback HTTP server maps A2A messages to managed provider tasks and their final responses to artifacts. Terminal discovery and SQLite internals remain private implementation details.

## Identity hierarchy

```text
host
└── terminal
    └── process instance (PID + process birth + run UUID)
        └── time-bounded session attachment
            └── provider session
                ├── turn
                └── subagent
```

A provider session may be resumed by another process later, and one process may attach to several sessions over its lifetime.

## State model

Process state and agent activity are independent:

```text
process: starting | live | stale | exited | crashed | unknown
activity: initializing | idle | thinking | using_tool |
          waiting_for_approval | waiting_for_user | compacting |
          failed | unknown
```

`Stop` means a turn completed; it never means the process exited.

## Event envelope

Normalized events use schema `local.agent.event/1` and retain provider, source, process/session/turn identities, observed and occurred timestamps, a stable idempotency key, sensitivity, causal origin, and hop count.

Hooks can arrive concurrently or out of order. The daemon stores both timestamps and assigns its own session-local sequence.

## Extension boundaries

- Add providers behind the adapter and hook normalizer interfaces.
- Add retrieval strategies behind memory search; FTS5 remains the baseline.
- Add managed transports without changing ordinary-session inbox semantics.
- Add external protocol bindings without exposing the internal schema as a public API.
- Add provider-native file isolation behind the fleet adapter contract without weakening existing fail-closed plan validation.
- Add remote storage/encryption backends behind the append-only synchronization contract without coupling them to local execution.
