# AgentGraph delivery plan

This document separates what the current alpha already does from the work required for a dependable public release.

## Product outcome

A developer should be able to install one local package, keep using ordinary Codex and Claude CLI sessions, and let those sessions:

1. discover which local agents are active;
2. retrieve explicit repository decisions and constraints;
3. exchange bounded context and artifacts;
4. create durable, auditable handoffs;
5. launch an explicit bounded cross-provider fleet without recursive spawning;
6. optionally share selected memory with a remote team;
7. preserve each provider's normal authentication, sandbox, and approvals.

Full transcript synchronization, hidden-reasoning extraction, terminal keystroke injection, and permission bypasses are non-goals.

## Phase 0 — functional local alpha

Status: implemented in `0.1.0`.

### Package and CLI

- Standalone TypeScript/npm repository.
- `agentgraph` executable with lazy-loaded commands.
- Node 20.19+ support; Node 22 recommended.
- Typecheck, unit/integration tests, production build, and npm pack path.
- Local development install through `npm link`.

### Presence

- Supervised `agentgraph codex`, `agentgraph claude`, and arbitrary `agentgraph run` processes.
- PID birth-token checks, heartbeats, leases, stale reconciliation, and exit reporting.
- Provider session correlation through hooks and `AGENTGRAPH_RUN_ID`.
- Heuristic discovery and manual attachment for already-running ordinary processes.
- Live/recent inspection through `agentgraph ps` and MCP.

### Local service

- Owner-only Unix socket.
- One background daemon and one SQLite writer.
- SQLite WAL mode, migrations, event log, and domain projections.
- macOS launchd setup and uninstall.
- Crash-safe hook spooling when the daemon is unavailable.

### Ordinary CLI integration

- Codex and Claude lifecycle-hook normalization.
- Safe config merging, backups, dry runs, idempotency, and owned-entry uninstall.
- MCP registration for both providers.
- Optional transparent `codex` and `claude` shims with recursion protection.
- `agentgraph doctor` diagnostics.

### Shared memory and graph

- Repository, worktree, session, and global scopes.
- Durable facts, decisions, constraints, procedures, warnings, questions, and summaries.
- FTS5 retrieval with a LIKE fallback.
- Provenance, confidence, importance, sensitivity, expiry, supersession, and soft deletion.
- Secret memories excluded from ordinary search and generated context packs.
- Evidence-backed graph nodes and edges.
- Bounded context packs and content-addressed artifact metadata.

### Handoffs

- Exact-session or scoped provider/repository inbox routing.
- Acknowledge, claim, start, complete, fail, decline, cancel, and expire transitions.
- Sender/recipient checks and claimed-session ownership.
- Enforced acknowledgement when requested.
- Context/artifact references, causal metadata, hop limits, and TTLs.
- Durable next-turn delivery for ordinary sessions.

### Managed and protocol surfaces

- Bounded Codex and Claude CLI adapters using native JSON event modes.
- Kimi Code managed adapter using its documented stream-JSON contract, with explicit opt-in to its non-interactive automatic permission policy.
- Captured provider session IDs and final responses.
- MCP tools/resources that proxy through the daemon.
- Experimental loopback-only A2A Agent Card and JSON-RPC façade.
- A reusable AgentGraph coordination skill.

### Cross-provider fleet orchestration

- `agentgraph fleet validate <plan>` and the explicit `agentgraph fleet run <plan>` execution path.
- Versioned JSON task DAG with dependency/cycle validation and deterministic execution waves.
- Per-task Codex, Claude, or explicitly opted-in Kimi selection.
- Root/task limits for task count, depth, concurrency, wall time, captured output, and declared artifacts.
- Provider-enforced Claude turn/USD ceilings and fail-closed rejection of unsupported Codex/Kimi guarantees.
- Existing linked-worktree verification, dry-run preparation commands for missing automatic worktrees, and explicit root/non-Git overrides.
- Dependency ordering for shared worktrees with writer access.
- PID-birth-verified cross-process writer leases with safe stale-lock recovery.
- POSIX process-group cancellation, fail-fast behavior, dependency failure propagation, and deterministic aggregation.
- Bounded artifact capture with path/symlink/inode checks.
- Managed-child lineage rejection plus prompt-level prohibition of recursive delegation.
- No automatic merge, push, release, or destructive worktree cleanup.

### Opt-in remote team-memory preview

- Separate authenticated HTTP(S) hub and append-only SQLite log.
- Team/repository authorization namespaces and authenticated actor stamps.
- Salted scrypt bearer-token hashes, revocation primitives, Host/Origin validation, TLS requirement off loopback, and request/rate/concurrency limits.
- Crash-safe client checkpoint, exclusive state lease, idempotent push batching, bounded streaming responses, monotonic pull cursors, and long-poll watch mode.
- Local memory-mutation outbox so more than a top-result snapshot can replicate, including deletion/supersession propagation.
- `secret` fail-closed exclusion, private-memory opt-in, remote-echo prevention, and untrusted-peer provenance labels.
- Actor-scoped local bindings so one remote actor cannot delete or supersede another actor's import.
- No remote agent execution, MCP exposure, or fleet control.

## Phase 1 — hardened developer preview

Goal: make failures boring and diagnosable for daily local use.

- Add structured daemon log rotation and a `doctor --verbose` support bundle with automatic secret redaction.
- Add migration rollback fixtures, corruption recovery documentation, and database backup/export/import commands.
- Add property tests for out-of-order and duplicate hook events.
- Add crash/kill tests for wrappers, daemon restarts, stale sockets, and SQLite WAL recovery.
- Add config-merge fixtures from real Codex and Claude configurations across supported versions.
- Add a presence confidence explanation to CLI output.
- Add inbox notifications that do not inject input into interactive terminals.
- Add explicit memory review/promotion policies for low-confidence generated summaries.
- Add retention controls, per-scope quotas, and auditable purge commands.
- Add automated release artifacts and signed checksums.

Exit criteria:

- Seven days of ordinary local use without lost handoffs or corrupted state.
- Repeated setup/uninstall leaves unrelated provider configuration byte-for-byte intact.
- Daemon restart and CLI crash scenarios pass on supported macOS versions.
- Every mutating MCP tool has identity, state-machine, and negative-path tests.

## Phase 2 — portable local service

Goal: support the same contract beyond macOS.

- Linux systemd user service installation.
- Windows named-pipe transport and user service installation.
- OS-specific process birth identity and terminal discovery adapters.
- Cross-platform path, permission, and shim tests in CI.
- Optional foreground/container mode without user-service installation.

Exit criteria:

- The same presence, memory, and handoff tests pass on macOS, Linux, and Windows.
- State directories and IPC endpoints remain private to the local user on each OS.

## Phase 3 — deeper provider adapters

Goal: improve managed delivery without changing ordinary-session safety.

- Codex App Server adapter behind the existing provider interface.
- Claude Agent SDK adapter behind the existing provider interface.
- Capability negotiation for immediate managed delivery.
- Streaming task progress normalized into AgentGraph events.
- Provider-specific resume, cancellation, approval, and timeout handling.
- Contract tests that ensure AgentGraph never weakens native permission policies.

Exit criteria:

- A managed task can stream, resume, cancel, and produce an artifact on both providers.
- Ordinary interactive sessions still use durable pull/next-turn delivery.

## Phase 4 — fleet enforcement and automation hardening

The bounded local fleet coordinator is implemented in Phase 0. This phase turns its remaining policy boundaries into deeper enforcement and adds optional lifecycle automation:

- Provider-native or OS-enforced filesystem profiles for read-only and per-worktree writer confinement.
- An unforgeable daemon-issued root-fleet capability instead of relying partly on inherited managed-lineage environment markers.
- Verified provider cost/turn telemetry where each vendor exposes a stable contract.
- Token budgets and usage aggregation in addition to byte/time bounds.
- Cleanliness, revision, branch, and expected-base checks displayed for every worktree.
- Optional worktree creation and cleanup with an explicit approval journal and crash recovery.
- Human approval gates before merges, pushes, deployments, external writes, or destructive cleanup.
- Configurable grader/aggregator tasks whose outputs remain ordinary reviewable artifacts.
- Restart/adoption records so a crashed coordinator can safely cancel or recover still-live children.
- Windows process-tree termination through Job Objects and equivalent cross-platform enforcement.

Fleet exit criteria:

- Read-only and writer boundaries are enforced outside the model prompt on every supported provider/OS.
- No child can forge authorization to start a descendant fleet.
- Every supported provider reports enforceable usage or clearly fails closed for the requested budget type.
- Killing the coordinator cancels or safely adopts every descendant process on every supported OS.
- Automated worktree operations are journaled, reversible, and never merge/push without a separate human approval.

## Phase 5 — A2A interoperability

Goal: make the external protocol surface standards-driven rather than experimental.

- Track the current A2A specification and publish an explicit supported-version matrix.
- Implement required task, message, artifact, cancellation, error, and streaming semantics.
- Add conformance fixtures against independent A2A clients.
- Add authentication before permitting any non-loopback binding.
- Keep internal terminal/process/database details out of the public protocol.

Exit criteria:

- Independent client conformance tests pass.
- The project can state a precise A2A compatibility level rather than “experimental.”

## Phase 6 — hardened team/remote mode

The opt-in memory-only preview already supplies TLS, token authentication, repository authorization, bounded transport, mutation replication, actor ownership, and deletion propagation. This phase makes it suitable for broader teams:

- Device identity and short-lived credentials instead of long-lived bootstrap bearer tokens.
- Administrative token issuance, rotation, revocation, repository membership, and audit APIs.
- End-to-end encryption for selected memory/artifacts with explicit team key-management and recovery design.
- Durable server audit events, metrics, backup/restore, schema migration, retention, and quota policies.
- Multi-hub replication and deterministic conflict handling for concurrent supersession/deletion.
- Per-record sharing policy and review queues instead of only public/private/secret export decisions.
- Signed provenance envelopes when claims must survive transport through an untrusted hub.
- PostgreSQL/object-storage production backends behind the same append-only contract.
- Deployment guides for a private network, reverse proxy, certificate rotation, and disaster recovery.
- Independent penetration test and privacy/security review.

Exit criteria:

- Remote mode passes an independent threat model, penetration test, and privacy review.
- Hub compromise cannot reveal E2E-encrypted record bodies selected for that mode.
- Device/token revocation takes effect within a documented maximum interval.
- Conflict and deletion semantics pass multi-host fault and partition tests.
- A local-only install opens no TCP listener and requires no cloud account.

## Release plan

Before publishing `1.0`:

1. choose a final available package name;
2. publish semantic-versioning and database-migration policies;
3. add CI for supported Node/OS combinations;
4. produce an SBOM and dependency audit;
5. document support boundaries for Codex and Claude versions;
6. complete an external security review;
7. ship upgrade, rollback, backup, and uninstall tests;
8. publish concise examples for solo developers, teams, and tool authors.

## Test matrix

Each release should cover:

- clean install, upgrade, repeated setup, dry run, and uninstall;
- no Codex installed, no Claude installed, and both installed;
- supervised, hook-discovered, attached, resumed, stale, crashed, and managed sessions;
- concurrent hooks, duplicate events, daemon downtime, and spool replay;
- repository/worktree scope isolation and secret-memory exclusion;
- handoff happy paths plus wrong-recipient, missing-ack, expired, duplicate, cyclic, and excess-hop cases;
- MCP initialization, tool discovery, identity inheritance, and daemon-unavailable errors;
- loopback-only A2A binding and malformed JSON-RPC requests;
- fleet schema/DAG validation, explicit-run gating, worktree ownership, stale leases, dependency failure, process-tree cancellation, and artifact escape attempts;
- remote disabled-by-default behavior, token/team/repository authorization, Host/Origin/TLS checks, bounded request/response behavior, state-lock crash recovery, cursor/idempotency replay, actor-scoped tombstones, outbox pagination, secret exclusion, and remote-echo prevention;
- native provider permission and sandbox preservation.

## Design decisions to preserve

- The daemon remains the sole SQLite writer.
- Presence liveness comes from process leases; semantic hooks enrich but do not replace it.
- A provider conversation is not treated as identical to a process or terminal.
- Peer-agent content is untrusted working context.
- Durable memory is intentional, scoped, provenance-bearing, and reviewable.
- Ordinary terminal sessions are not controlled with synthetic keystrokes.
- Remote access is opt-in and requires a separate security boundary.
