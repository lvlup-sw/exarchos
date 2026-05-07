**Target:** [`lvlup-sw/exarchos#1098`](https://github.com/lvlup-sw/exarchos/issues/1098) (envelope ticket — primary)
**Cross-references:** `#1099` (next_actions integration), `#1100` (NDJSON streaming), `#1088` (epic)
**Reason for manual paste:** my Microsoft EMU identity (`salusreed_microsoft`) cannot comment on third-party orgs. Paste from a personal/unmanaged GitHub identity.

**Status:** revised after a follow-on MCP protocol/SDK conformance spike resolved several open questions from the original draft. Replaces my earlier draft in this session.

---

Drive-by from a downstream MCP-server tool (`SCS-ISCE-Ev2Tooling/src/tools/ev2-mcp`) that ran two research spikes against milestone-16 patterns. Posting here because `#1098` is the envelope-shape issue, but the findings touch `#1099` and `#1100` as well.

## The principle

**Where MCP 2025-11-25 already specifies a primitive that solves the problem, milestone 16 should ride that primitive instead of inventing alongside it.** The current epic predates two pieces of the spec landing — `outputSchema` / `structuredContent` is now stable, and `tasks` (SEP-1686) is Final on the SEP track and present in the 2025-11-25 spec. Both are implemented in the official TypeScript SDK (`@modelcontextprotocol/sdk@^1.12.0`) and the C# SDK (`ModelContextProtocol@v1.2.0`, with `[Experimental(...)]` on the Tasks surface).

Three concrete swaps fall out of that principle.

## 1. Envelope shape (#1098) — use `outputSchema` + `structuredContent`

The 2025-11-25 spec gives milestone 16's "uniform envelope" exactly the dual channel it wants:

- `content[0]`: human-readable prose (what the `message` summary is for)
- `structuredContent`: validated against the tool's `outputSchema`, carries `{ok, data, next_actions, error?, fix?, _meta?}`

Spec verbatim (Tools §Structured Content): *"For backwards compatibility, a tool that returns structured content **SHOULD** also return the serialized JSON in a TextContent block."* That is the official guidance for exactly the dual-channel pattern.

**Implication:** the envelope IS the `outputSchema` on the MCP surface — define it once in Zod, MCP carries it natively, no JSON-in-text wrapper needed. The CLI surface still needs the literal envelope (no protocol-level structured channel for stdout) — opt-in via `--format json`. The contract is identical; only the carrier changes per surface.

This also gives MCP parity (`#1109`) a sharper definition: "same logical envelope shape, surface-native delivery" rather than literally identical bytes — which avoids MCP responses carrying JSON-in-text purely to match the CLI.

## 2. NDJSON streaming (#1100) — Tasks (SEP-1686) supersedes this entirely

This is the largest revision, and the one most worth pushing back on.

SEP-1686 introduces `tasks` — request augmentation for long-running operations with capability negotiation, polling/result/cancel semantics, side-channel `_meta`, and an `input_required` status for human approval gates. The 2025-11-25 spec text marks Tasks "experimental" even though SEP-1686 is Final, so adoption requires a deliberate risk acceptance — but the surface is implemented in both SDKs today.

Map it onto `#1100`'s NDJSON design:

| `#1100` NDJSON (proposed)                                       | Tasks (spec'd in 2025-11-25)                                      |
| --------------------------------------------------------------- | ----------------------------------------------------------------- |
| Custom envelope: `start \| event \| progress \| result \| error` | Two-phase: `tools/call` returns `CreateTaskResult` → `tasks/get` polling → `tasks/result` |
| Dedup by sequence number that we'd implement                    | Per-task FIFO via spec'd `TaskMessageQueue`                       |
| `--follow` flag emits one JSON per line                         | Capability negotiation: clients that don't speak Tasks call normally and get one-shot — no breaking change for existing consumers |
| (no equivalent)                                                 | `tasks/cancel` and `tasks/list` first-class                       |
| (no equivalent)                                                 | `input_required` status — natural fit for human approval/clarification flows |
| Maps to event-store entries (Exarchos-specific)                 | Maps to `TaskStore` (in-memory ships in both SDKs; persistent stores pluggable) |

The SDK already implements this — TS via `server.experimental.tasks.registerToolTask()` (`dist/esm/experimental/tasks/`); C# via `IMcpTaskStore` + `[McpServerTool]` returning `Task<McpTask>`. SEP-1686's customer use case #4 (test execution platforms wrapping CI/CD APIs) reads almost word-for-word as the motivation for `--follow` on workflow-state queries.

**Suggested action on `#1100`:** close in favor of a "tasks adoption" issue scoped to the actual long-running surfaces (`exarchos_workflow get --follow`, `exarchos_view shepherd_status --follow`, etc.). The CLI `--follow` flag stays — its implementation becomes "loop `tasks/get` until terminal, render each update," not a custom NDJSON wire format Exarchos owns and documents.

## 3. `next_actions` (`#1099`) — lives in `outputSchema`, validated automatically

Same typed shape proposed in `#1099` — but if the envelope rides `structuredContent` per #1 above, the `next_actions` types live in the tool's registered `outputSchema`. Clients get Zod-level validation for free instead of having to trust an envelope hand-rolled inside text.

The mapping from `_eventHints.emitted` / `suggestedFix` / `validTargets` / `_corrections` / `_meta.checkpointAdvised` to typed actions doesn't change. Only the delivery channel does.

## Adjacent — three more spec-stable primitives worth a look

Also confirmed stable in 2025-11-25 / both SDKs, in case any are on the milestone-16 horizon:

- **Tool annotations** (`destructiveHint`, `readOnlyHint`, `idempotentHint`, `openWorldHint`) — direct fit if the agent UI ever needs to surface "this would cancel an in-flight workflow" warnings. Spec caveat: clients **MUST** treat annotations as untrusted unless the server is trusted, so they're UI hints — not a substitute for server-trusted gating metadata if you need both.
- **Elicitation** (form mode + URL mode) — replaces the typical "tool errored because required param missing → agent retries" loop. Server asks the user via the client UI; resumes when answered. URL mode is the right path for credential-bearing flows (spec forbids form mode for secrets).
- **Roots** — replaces ad-hoc `process.cwd()` walks for project-boundary discovery. Useful if Exarchos servers want to resolve `featureId` workspace paths from the client's declared roots.

## Risk note on Tasks

Tasks is marked "experimental" in the 2025-11-25 spec text and `@experimental` (TS) / `[Experimental(...)]` (C#) in the SDKs — even though SEP-1686 itself is Final. The C# `[Experimental(...)]` attribute produces a compiler warning at every callsite, which makes the API-stability risk visible.

What worked for our spike: bound first adoption to one tool (the highest-value long-running case), pin the SDK minor version instead of caret-range, treat as adoption-zone-only until the spec text drops the "experimental" badge. Same approach should work for Exarchos's first Tasks adoption.

## Sources

- Spec: [tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks.md), [tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools.md), [SEP-1686](https://modelcontextprotocol.io/seps/1686-tasks.md), [elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation.md), [roots](https://modelcontextprotocol.io/specification/2025-11-25/client/roots.md)
- TS SDK: `@modelcontextprotocol/sdk@^1.12.0` — `dist/esm/server/mcp.d.ts:154,257` (`outputSchema`/`structuredContent`), `dist/esm/experimental/tasks/{interfaces,mcp-server,stores/in-memory}.d.ts`
- C# SDK: `ModelContextProtocol@v1.2.0` — `Protocol/{McpTask,McpTaskStatus,McpTasksCapability}.cs`, `Server/{InMemoryMcpTaskStore,TaskExecutionContext}.cs`, `samples/LongRunningTasks/`
