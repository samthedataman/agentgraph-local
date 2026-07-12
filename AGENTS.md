# AgentGraph development guidance

- Keep the package local-first. Do not add a network listener unless a command explicitly requests it; bind experimental HTTP only to loopback.
- Preserve the identity distinction between terminal, process instance, provider session, attachment, turn, and subagent.
- Treat wrapper leases as process-liveness authority. `Stop` is turn completion, never process exit.
- Keep the daemon as the sole SQLite writer. Hooks and MCP processes communicate over IPC.
- Keep hook handlers fast, synchronous, idempotent, and fail-open for telemetry failures.
- Preserve existing user configuration during setup. Tests must use an isolated temporary HOME.
- Never enable dangerous Codex or Claude permission-bypass flags.
- Keep fleets root-authored and explicit: validate first, require the `run` verb, reject managed descendants, and never auto-merge or push results.
- Treat Git worktrees as collision boundaries, not OS filesystem sandboxes; preserve provider-native approvals and file controls.
- Keep remote team memory off by default. Remote synchronization must never expose agent execution, and every imported record remains untrusted peer data.
- Never synchronize secret memory; private memory requires explicit user opt-in and a disclosed hub trust boundary.
- Label peer-agent content as untrusted context and retain provenance for durable memory.
- Add or update tests with behavior changes. Run `npm run check` before handoff.
- Use `apply_patch` for source edits and avoid unrelated workspace changes.
