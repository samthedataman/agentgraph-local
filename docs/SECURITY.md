# Security and privacy

AgentGraph joins multiple powerful local agents. Its default posture is local, scoped, evidence-backed, and fail-safe around execution.

## Primary threats

- Prompts and tool output may contain credentials or customer data.
- A peer model can produce prompt-injection text.
- One repository must not silently retrieve another repository's private memory.
- A local process can attempt to spoof events or a lease.
- Recursive delegation can waste time, quota, and money.
- Two writers can damage the same worktree.
- A network-exposed local service can create authentication and DNS-rebinding risk.

## Controls

- Use an owner-only Unix socket and state directory.
- Use random run and lease identifiers.
- Validate PID plus process birth time rather than PID alone.
- Spawn provider commands with argv arrays, never interpolated shell strings.
- Treat supervised and inferred sessions with different confidence.
- Keep repository/worktree scope on every durable memory.
- Exclude memories marked `secret` from search and generated context packs unless a caller explicitly requests a direct secret search.
- Preserve evidence references and confidence.
- Redact secret-shaped data before persistence.
- Store large outputs as explicit, content-addressed artifacts rather than ordinary memory.
- Label peer messages as peer data, not privileged instructions.
- Require acknowledgement by default, assign a 24-hour default expiry, enforce hop limits, and retain causal metadata for handoffs.
- Preserve native Codex and Claude approvals and sandboxes.
- Bind the experimental A2A server only to loopback.
- Require a random bearer token on every A2A request, including Agent Card discovery.
- Reject non-loopback `Host` headers and non-loopback browser `Origin` headers.
- Bound A2A concurrency, request bodies, returned artifact text, and retained in-memory tasks.
- Require the literal `fleet run` action before starting managed workers.
- Validate fleet DAG, task count/depth/concurrency/time/output/artifact limits, provider-specific guarantees, and worktree boundaries before launch.
- Require dependency ordering for shared worktrees with writer access and an exclusive PID-birth-verified writer lease.
- Launch managed provider CLIs as POSIX process groups so timeout/cancellation reaches descendants.
- Treat fleet dependency responses and captured artifacts as untrusted peer data in downstream prompts.
- Keep remote sync disabled unless explicitly enabled.
- Require TLS and explicit allowed hosts for every non-loopback remote hub.
- Authenticate every hub request with a salted-hash bearer token and stamp authenticated actor identity onto stored records.
- Authorize every push/pull against both team and repository namespace.
- Bound remote request bodies, record counts, pull responses, concurrency, rate, and long-poll duration.
- Keep remote sync checkpoints and hub databases private, atomically written, and independent from the local daemon database.
- Never synchronize `secret` memory; require `--share-private` for private memory.
- Scope remote update/deletion bindings to the authenticated actor that created them.

The A2A bearer token is an additional local capability, not a substitute for
provider authentication. AgentGraph passes tasks through the normal Codex or
Claude CLI and does not enable permission-bypass flags. Keep the token out of
shell history and logs; prefer `AGENTGRAPH_A2A_TOKEN` when a stable token is
needed for local automation.

## Local trust boundary

The alpha treats processes running as the same operating-system user as trusted local clients. The owner-only socket prevents other users from connecting, but it is not authentication against malicious software already running under your account. Such a process could call daemon RPC methods directly. Per-process RPC capabilities are planned before any remote or multi-user mode.

Repository and worktree scopes prevent accidental cross-project retrieval in normal MCP workflows; they are not a security boundary against the owning user, who can access the SQLite file and CLI directly.

The same trust limitation applies to managed fleet workers. A separate Git worktree prevents accidental file collisions and makes changes reviewable, but it is not an operating-system filesystem sandbox. A provider process running as the user can address other user-readable paths. Use provider-native sandbox controls, disposable worktrees, narrowly scoped objectives, and human review. Kimi automatic-permission tasks require special care.

## Event retention

Lifecycle hooks retain normalized event payloads so sessions can be correlated and debugged. Secret-shaped keys and common token formats are redacted, managed streams are sanitized before persistence, and supervised CLI arguments are not stored. Redaction cannot guarantee that arbitrary customer data or novel credential formats are removed. Do not put secrets in prompts or tool arguments, and use an isolated `AGENTGRAPH_HOME` for sensitive experiments. Configurable event-retention and purge policies remain preview work.

## Configuration writes

`agentgraph setup` must:

1. Support `--dry-run`.
2. Back up files before editing.
3. Parse and merge existing hook arrays.
4. Be idempotent.
5. Remove only AgentGraph-owned entries during uninstall.
6. Never enable provider permission bypasses.

## Memory trust

Memory is not automatically truth. Callers should prefer current, high-confidence, corroborated entries and inspect provenance when a decision matters. Generated summaries must be distinguishable from direct observations or intentional agent/user commits.

## Remote team-memory preview

The remote feature exposes a memory synchronization API, not local MCP, A2A, fleet, shell, or provider execution. It is off by default. Loopback development may use HTTP; non-loopback binding requires TLS plus explicit Host allowlisting. Browser Origins are rejected unless explicitly trusted.

Bearer tokens authorize one team and a bounded repository list. The hub stores salted scrypt hashes rather than token plaintext and stamps the authenticated token ID onto accepted records. Client-asserted provenance remains untrusted metadata; the authenticated actor stamp is the ownership input used for local update and tombstone bindings.

Remote records are append-only and provenance-bearing, but peer text can still contain mistakes or prompt injection. Imports are labeled `untrusted-peer`, and context packs state that peer content is data rather than instruction. Agents and humans must still verify important claims.

The preview is not end-to-end encrypted. TLS protects transport, and file permissions protect local storage, but the hub operator can read synchronized payloads. Never synchronize credentials, regulated customer data, or material that the hub operator is not authorized to see. Use a separate repository-scoped token and trusted private network or gateway; do not place the preview hub directly on the public internet.

Remote token revocation, full audit-event export, device identity, E2E encryption, multi-hub conflict resolution, and external security review remain release work.
