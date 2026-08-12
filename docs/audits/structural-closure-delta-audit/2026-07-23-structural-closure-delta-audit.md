# Structural Closure Baseline Audit — v1

> **Canonical implementation plan:**  
> [`unified-remediation-plan.md`](./unified-remediation-plan.md) merges this
> report, the remediation backlog, phase-gate admission design, dogfood
> analysis, structural principles, and the proof-substrate handoff into one
> dependency sequence. This report remains the evidence base.

**Audited code snapshot:** `13cf9642b9c3ec5dec5a4bcfdbfc5ac6904a75f5`  
**Report authoring HEAD:** `6985fea1140d04191205b4e0b5d8bcd8b16c47eb`  
**Purpose:** Establish the first actionable structural baseline for codebase remediation.  
**Verdict:** **Not structurally closed. Begin with the P0 truth and gate-restoration programs.**

> The existing filename is retained for workflow continuity. This report is a
> current-state baseline. Commit-delta chronology is relegated to the appendix.

## Executive decision

The audited snapshot has strong local architecture and unusually broad test and
ratchet coverage, but its proof system is not closed end to end. The highest
leverage work is not another broad refactor: it is restoring authoritative state,
making blocking gates truthful, and then generating public surfaces and artifact
proof from stable chokepoints.

- **Structural maturity:** **17/28**
- **Canonical implementation items:** **61**
- **Priority distribution:** **7 P0**, **40 P1**, **14 P2**
- **Remediation programs:** **7**
- **Inventory evidence:** **612 rows** — 77 closed, 289 partial, 239 open, 7 indeterminate
- **Static effect candidates:** **339** — 301 map to an owner row, including 131 that currently map only to the indeterminate placeholder owner; 38 are explicitly excluded as build/CI tooling
- **Blocking enforcer coverage:** 12 pass, 2 fail, 2 blocked by missing prerequisites, 1 not run because PR context is unavailable

### Immediate priorities

| ID | Change | Why now | Primary targets | First acceptance proof |
|---|---|---|---|---|
| BASE-001 | Restore the candidate type-debt gate to green | The candidate cannot claim structurally enforced type safety while a gating register fails on the exact snapshot under audit. | servers/exarchos-mcp/src/storage/sqlite-backend.ts, servers/exarchos-mcp/src/workflow/cleanup.ts, servers/exarchos-mcp/src/workflow/tools.ts | node scripts/check-type-debt.mjs exits 0 on the candidate branch |
| BASE-002 | Resolve the dead-in-production gate reliability view | The candidate presents gate reliability as a closure gain, but the implementation is not selected by production and also breaks a blocking module-intent ratchet. | servers/exarchos-mcp/src/views/gate-reliability-view.ts, servers/exarchos-mcp/src/views/composite.ts, servers/exarchos-mcp/src/registry.ts | node scripts/check-module-intent.mjs exits 0 |
| EFF-001 | Prove event-store append atomicity under concurrency and add startup sequence/version repair | Diverged sequence/version rows block task completion, task failure, checkpoints, team lifecycle events, and state reconciliation (dogfood CB-1 impact statement); every downstream projection (CB-8) inherits the corruption. | servers/exarchos-mcp/src/event-store/atomic-appender.ts, servers/exarchos-mcp/src/storage/sqlite-backend.ts, servers/exarchos-mcp/src/event-store/multi-process.test.ts | New/extended multi-process.test.ts triggers concurrent competing appends and asserts a single consistent (sequence, version) outcome with no silent divergence |
| EFF-002 | Emit a blocking projection-degraded signal on stream/event/projection sequence disagreement | Consumers (orchestrate.describe, pipeline/workflow-state views, delegation readiness) can read and act on stale or contradictory state with no fail-safe, propagating CB-1-class corruption into operator-visible decisions. | servers/exarchos-mcp/src/views/workflow-state-projection.ts, servers/exarchos-mcp/src/views/gate-reliability-view.ts, servers/exarchos-mcp/src/projections/rebuild.ts | Fault-injection test seeds a lagging projection cursor behind the event max sequence and asserts every consuming view returns a typed degraded state, not stale data |
| WFQ-002 | Scope prepare_delegation/worktree readiness to the current waves task list, not all historical task.assigned events | Makes incremental/wave-scoped delegation unusable in practice, forcing all-or-nothing dispatch and defeating the purpose of wave decomposition. This is a confirmed regression of previously-closed issue #1206. PRODUCT CODE BUG. | servers/exarchos-mcp/src/views/delegation-readiness-view.ts, servers/exarchos-mcp/src/verbs/team/prepare-delegation.ts | A regression test replays 17 historical task.assigned events then calls prepare_delegation with a 4-task wave and asserts readiness is computed over exactly those 4 tasks |
| WFQ-003 | Stop parsing full npm/vitest stdout as one JSON document in check_integration_suite | The task-completion runbooks final blocking gate (CB-5) fails on unrelated output framing rather than actual test results, for every task, adding a spurious full-suite failure signal on top of already-expensive per-task verification. Matches currently-open issue #1537. PRODUCT CODE BUG. | servers/exarchos-mcp/src/verbs/gates/check-integration-suite.ts, servers/exarchos-mcp/src/verbs/pure/integration-suite.ts | A test runs the gate against a real npm-wrapped vitest invocation with non-JSON preamble output and asserts parseError:false with correct pass/fail/failCount |
| WFQ-004 | Reorder task-completion runbook so task_complete never precedes its own blocking gate, and remove duplicate verification ownership | Task completion state can misrepresent verification outcome (complete recorded, then blocking gate fails); per-task full-suite runs multiply wall-clock cost across 17 tasks; verification ownership ambiguity is a direct dogfood-cited contributor to the run being slower than comparable harnesses. PRODUCT CODE BUG (ordering) + PROCESS/SKILL DESIGN GAP (ownership). | servers/exarchos-mcp/src/runbooks/definitions.ts, skills-src/delegate/SKILL.md | A runbook-shape test asserts task_complete is after every blocking per-task gate and no blocking per-task gate can occur later. |

## How to use this report

1. Select a **program**, not an isolated symptom, when planning a feature wave.
2. Use the member backlog IDs as implementation-spec requirements.
3. Preserve the acceptance proof verbatim unless design work replaces it with a stronger proof.
4. Re-run the native gates and this audit after each program, not after every small task.
5. Treat P2 items as sequencing/retirement work; do not let them displace P0 truth defects.
6. `recommendedWave` is a priority/program bucket; item dependency arrays are authoritative for ordering within the same wave.

## #1608 target-state invariant overlay

Current-catalog compliance remains historical evidence. The implementation
backlog targets the accepted direction in #1601/#1599/#1608. For INV-11, the
latest #1601 clarification supersedes the older child-issue spatial claim:
the launcher owns lifecycle and top-level placement, not arbitrary filesystem
writes.

| Invariant | Current catalog | Target state | Audit/backlog impact |
|---|---|---|---|
| INV-2 | CLI and MCP are sibling facades over one dispatch core, with parity proven by tests. | The MCP contract is the single invocation surface. The CLI is a generated in-process client and presentation layer over that contract. | Parity is no longer the primary closure mechanism. The parity suite becomes a contract-codegen golden/differential test. Packaged tests still prove built-artifact selection and rendering, not duplicate business behavior. |
| INV-4 | Six runtime renderings are first-class and drift-guarded. | Emit standard Agent Skills, AGENTS.md, and MCP artifacts once; retain thin shims only where no standard exists. | Per-runtime fan-out is technical debt, not the target architecture. Conformance and shim minimization replace render-parity as the primary metric. Every residual shim needs an owner, capability reason, and retirement condition. |
| INV-11 | Task-isolated agents are described as unable to write outside their worktree by construction. | The launcher owns lifecycle and top-level placement. Spatial write confinement is a per-harness capability and requires a Bash-covering hook standard or a kernel sandbox. | Launcher/WLM acceptance must not claim filesystem write confinement. Lifecycle and spatial isolation become separate audit dimensions. The capability contract must report prevention, detection, advisory, or unavailable posture per harness. |

### Authority implications

- Current behavior is measured against the committed invariant catalog.
- Target-state recommendations use #1601/#1599 latest clarifications when child issue text is stale.
- Shared workflow/event/evidence IR types come from Strategos.Contracts.
- Exarchos-specific product API, presentation, policy, and implementation bindings remain Exarchos-owned.

### External authority pinning

**MCP specification/SDK**

- Pin the exact 2026-07-28 RC/final specification revision and SDK version used by codegen.
- Vendor the protocol JSON Schemas and hand-authored conformance fixtures with source URL, commit/release digest, and license/provenance.
- Never generate against a floating latest specification or SDK.
- When final/SDK changes, produce a machine-readable schema/behavior diff and migration decision before regeneration.

**v3 architecture decisions**

- Record an interim approved ADR/contract freeze for API-001/CTR-012 decisions.
- Every later #1258/#1247/#1599 change must diff against the frozen contract and classify compatibility/migration impact.
- Downstream generated work may proceed against the pin, but cannot be declared final until the authoritative issue/doc accepts or supersedes it.

**Fallback during the RC/final window**

- Feature-flag the pinned draft adapter/compiler output from the stable runtime path.
- Keep migration fixtures capable of regenerating from both pinned draft and final spec during the transition window.
- Refuse release when generated artifacts reference an unapproved or floating authority digest.

This overlay does not rewrite the v1 score. It changes the target architecture
and therefore the remediation programs and acceptance gates.

## MCP-to-Exarchos API contract compiler

The MCP protocol is the wire protocol and schema substrate. It is **not** the
complete Exarchos product API contract. The target compiler composes protocol,
shared workflow IR, product policy, implementation binding, and generated
presentation/artifact layers.

### Authority layers

| Layer | Owner | Responsibility |
|---|---|---|
| protocol | MCP specification 2026-07-28 | Stateless request/response transport, full JSON Schema 2020-12 tool contracts, structuredContent, request _meta, discovery, cache metadata, Tasks extension, cancellation, and protocol error codes. |
| shared-ir | Strategos.Contracts | Cross-product workflow IR, event/evidence subjects, gate classes, fork/compensation edges, decisions, abstention/error unions, and shared compatibility shapes. |
| exarchos-api | Exarchos | Composite tools, actions, envelopes, next actions, policies, host commands, standard artifact projections, extension handshake, compatibility, and presentation metadata. |
| implementation-bindings | Exarchos runtime | One exact handler and optional summarizer/presenter hook per stable action ID; functions never enter the serializable wire contract. |
| generated-clients-and-artifacts | Contract compiler | MCP registration, runtime validators/types, CLI client/parser/renderers, fixtures, standard skills/instructions, documentation catalogs, and Workflow Builder action references. |

### Proposed source layout

- `contracts/exarchos-api/main.tsp`
- `contracts/exarchos-api/tools.tsp`
- `contracts/exarchos-api/envelope.tsp`
- `contracts/exarchos-api/errors.tsp`
- `contracts/exarchos-api/policies.tsp`
- `contracts/exarchos-api/presentation.tsp`
- `contracts/exarchos-api/extensions.tsp`
- `contracts/exarchos-api/compatibility.tsp`
- `contracts/implementation-bindings.ts`

### Product contract identity

- apiContractVersion
- mcpSpecificationVersion
- packageVersion
- buildSourceSha
- contractDigest
- supportedProtocolFeatures
- compositeTools
- hostCommands
- standardArtifactProjections
- extensionContract

### Disjoint API/CLI surface partition

**Rule:** Every CLI-visible ID is exactly one of API action, API presentation alias, or host command.

- **API action:** MCP-invocable contract action with one stable ActionId and implementation binding.
- **API presentation alias:** CLI spelling or top-level promotion that references one API ActionId and owns no behavior/schema.
- **Host command:** Local process/bootstrap/server operation that cannot be invoked through MCP; must state why.

Current standalone classification:

- API presentation aliases: doctor, feedback, schema, topology, emissions, onboard, init, merge-orchestrate
- Host commands: mcp, version, install-skills

### Action contract

#### Stable identity and lifecycle

- stableActionId
- toolName
- actionName
- contractVersion
- stability: experimental|preview|stable|deprecated
- introducedIn
- deprecatedIn
- replacementActionId
- aliases
- visibility: public|hidden

#### Total schemas

- inputSchema JSON Schema 2020-12
- success data schema
- closed error union
- full output envelope schema
- capped/degraded/detail/paginated output variants
- examples and negative fixtures

#### Execution policy

- allowed phases and roles
- trusted safety class
- readOnly/destructive/idempotent/openWorld hints
- effect class and owner reference
- dry-run policy
- compensation policy
- queryability and next-action semantics
- task suitability, TTL, cancellation, and follow/wait semantics
- response economy budget and summarizer hook ID
- cacheScope and ttlMs

#### Evidence policy

- auto-emitted event types
- required model-emitted events
- subject and provenance requirements
- artifact/evidence references
- admission requirement IDs

#### Presentation policy

- CLI command, aliases, grouping, and top-level promotion
- flag names, aliases, coercion, requiredness, and secret redaction
- human formats: table|tree|text|json
- compact/detail/pagination affordances
- dry-run rendering
- exit-code mapping by closed error code
- examples and help text

### Envelope and error contract

#### Success carrier

- success=true
- typed data
- next_actions
- _meta operation/correlation/projection identity
- _perf
- warnings
- _corrections
- _eventHints
- _cacheHints

#### Failure carrier

- success=false
- closed error code
- message
- action
- validTargets
- suggestedFix
- expectedShape
- retryability and retryAfter
- same diagnostic side channels as success where applicable

#### Carrier invariants

- Every emittable runtime shape is represented in the output schema.
- No success-shaped fallback exists outside the declared union.
- CLI --json emits the same envelope data contract as MCP structuredContent.

### Total error-layer mapping

**Failure origins**

- transport and JSON-RPC framing errors
- unknown MCP method/tool/action errors
- input/schema/coercion errors
- authentication and authorization errors
- capability/workspace/tenant policy errors
- task creation, polling, expiry, ownership, and cancellation errors
- deadline/timeout and client cancellation
- action/domain failures returned by handlers
- output-schema and economy violations
- adapter/presenter exceptions
- unexpected internal exceptions

**Normalized fields**

- layer
- stableCode
- protocolCode and isError mapping
- typed details schema
- retryable and retryAfter
- validTargets and suggestedFix
- CLI exit code
- compatibility/version behavior
- redaction policy

**Rule:** Every failure origin maps exactly once into the closed Exarchos failure envelope or a protocol error defined by the contract; no throw or adapter-only shape bypasses the mapping.

**Required tests**

- unknown method/tool/action
- invalid input/coercion
- authorization and scope denial
- task expiry/ownership/cancellation
- timeout and cancellation race
- handler failure
- invalid output shape
- presenter exception
- internal exception redaction

### Host-local command contract

API actions are generated MCP-contract clients. Host bootstrap/launcher/server
operations are explicit exceptions, not hidden facade drift.

- stableCommandId
- reasonHostLocal
- input/error/result contract
- effects and safety
- exit codes
- relationship to MCP actions
- retirement or standardization path

Examples: mcp server mode, launcher harness verbs, install-skills/bootstrap operations, version/build identity inspection.

### Extension trust contract

- extension identity and version
- signed publisher identity and implementation provenance
- tool/action schemas and contract digests
- immutable admitted implementation/package digest
- trusted/untrusted annotations
- effect capabilities
- authentication/authorization requirements
- compatibility range
- conflict and namespace rules
- resource/schema complexity limits and quotas
- isolation/sandbox requirement
- minimum harness spatial posture required per effect capability
- revocation and expiry metadata

**Trust rule:** Untrusted consumer schemas may be presented but never promoted to server-trusted safety/effect policy without server-owned admission. Admission pins signed identity and implementation digest, applies namespace/effect allowlists and quotas, and is revalidated before execution to prevent TOCTOU swaps.

**Extension security tests**

- schema expansion bomb and oversized recursive schema
- undeclared filesystem/process/network effect
- digest swap after admission
- namespace/action capture
- forged publisher or trusted annotation
- revoked or expired extension
- stale revocation cache and revocation-source outage
- revocation-epoch rollback and local clock rollback
- sandbox/limit violation

**Signing profile**

- Format: DSSE envelope over an RFC 8785 canonical JSON admission payload
- Supported trust: Sigstore keyless identity with Fulcio certificate + Rekor inclusion; or explicitly configured offline trust roots for air-gapped installs

Signed payload:

- publisher identity
- extension ID/version and monotonic release counter
- implementation/package digest
- API contract and schema digests
- action IDs/namespaces
- trusted/untrusted policy declarations
- effect capabilities and resource limits
- compatibility range
- issued-at, expiry, revocation epoch

Trust policy:

- allowed issuer, subject/repository, workflow identity, and ref/tag policy
- key/issuer rotation overlap window
- revocation source and cache freshness
- maximum revocation-cache age; stale or unavailable source fails closed for new admission/execution
- offline signed revocation list/checkpoint for disconnected operation
- monotonic revocation epoch and rollback-resistant trusted time/clock policy
- transparency-log inclusion or offline equivalent
- anti-rollback: reject lower version/revocation epoch or stale integrated timestamp

**Harness-posture-aware isolation admission**

Posture levels:

- prevention: kernel sandbox or Bash-covering blocking hook owns the write path
- detection: post-write detection with attributable durable violation evidence
- advisory: prose/instruction only
- unavailable: no meaningful spatial control

Admission rules:

- Each extension effect capability declares the minimum required posture.
- Admission resolves the target harness posture from server-trusted capability evidence, never extension metadata.
- If the harness posture is below the required level, execution is refused or explicitly downgraded to a capability-safe mode such as read-only.
- Advisory/unavailable posture cannot admit arbitrary filesystem/process/network extension code as trusted.

Required posture tests:

- prevention tier blocks an undeclared filesystem/process effect
- detection tier records and attributes the violation and applies declared failure policy
- advisory tier refuses an extension requiring prevention
- unavailable tier refuses execution or restricts it to a no-effect/read-only mode
- forged extension posture metadata cannot upgrade the server-resolved harness posture

### Stateless runtime contract

**Forbidden server authority/state**

- initialize/oninitialized session state
- notification-populated roots caches
- connection-scoped client identity/capabilities
- connection-scoped task ownership
- in-memory-only task/cancellation state required for resumption

**Request-scoped context**

- transport-authenticated principal
- untrusted request _meta hints
- server-derived capabilities and policy
- workspace/repository/tenant scope
- request, invocation, operation, and correlation IDs
- roots/resource view resolved for this request
- deadline/cancellation token

**Roots and reverse requests**

- roots/list or successor semantics are request-scoped and never cached as authority across clients
- elicitation and sampling/reverse requests bind to the initiating request/task and authenticated client route
- load-balancer routing either preserves the reverse-request route or returns a typed unsupported/input-required result

**Durable Tasks semantics**

- globally unique task ID independent of server process
- authenticated owner/principal and workspace scope
- durable state, result, progress cursor, and idempotency key
- expiry, tombstone, retention, and garbage-collection policy
- idempotent cancellation and terminal-state conflict rules
- durable worker lease and monotonically increasing fencing token
- terminal-state precedence and rejection of stale post-cancel result/effect commits
- restart and cross-instance resume/load-balancer behavior

**Required multi-client/restart tests**

- Alternate requests from two clients across fresh server instances and prove no capability/root/principal leakage.
- Create a task on one instance, poll/cancel/resume on another, restart all instances, and recover the same durable state.
- Reject cross-principal/workspace task reads and cancellation.
- Prove expired/tombstoned task behavior and idempotent repeated cancellation.
- Race cancellation against effect/result commit from an old fenced worker and prove the stale commit is rejected.

### Authentication and authorization context

**Trust model**

- Transport or host integration authenticates the principal; request _meta never authenticates.
- Server derives trusted capabilities, roles, workspace/tenant scope, and policy.
- Client metadata is retained only as untrusted presentation/compatibility hints.
- Evidence producer identity binds to the authenticated principal and server-validated implementation.

**Per-action authorization**

- required principal class
- required scopes/roles
- workspace/repository/tenant constraints
- cross-resource policy
- anti-replay/idempotency requirement
- server-derived capability requirement

**Anti-replay**

- request/operation ID uniqueness policy
- timestamp/deadline tolerance
- nonce or idempotency-key binding for mutations
- principal + action + subject binding
- canonical full-request digest including normalized input, selected MCP/API/action versions, contract digest, policy digest, principal, workspace scope, and effect subject
- shared durable replay ledger or idempotency-claim table visible to every server instance
- atomic claim-before-effect transaction and duplicate-result recovery
- retention, expiry, tombstone, and garbage-collection rules sized to the replay window

**Stable claim identity**

- caller-supplied or server-issued idempotency key
- authenticated principal
- workspace/tenant scope
- stable ActionId
- stable action namespace

**Request fingerprint**

- canonical normalized full input
- stable effect subject identity
- selected MCP/API/action versions
- contract digest
- authorization/effect/policy digest

**Upgrade rule:** Stable claim identity is version-independent and reserves the idempotency key across subjects. If a retry presents a different subject/request/version/policy fingerprint, the server returns a typed idempotency conflict or explicit migration decision; it never creates a fresh effect claim implicitly. Stored-result replay requires current authorization and a lossless projection to the negotiated result schema, otherwise it returns forbidden/conflict/migration.

**Replay claim state machine**

- claimed
- effect-started
- completed with stored typed result
- failed-retryable
- failed-terminal
- compensating
- compensated
- compensation-failed-needs-manual-intervention
- abandoned/expired

**Replay/crash recovery**

- durable lease owner and fencing token
- lease expiry and atomic takeover
- stored-result replay for completed claims only after current authorization and lossless negotiated-schema projection
- effect-specific precheck/reconciliation before retry
- compensation requirement for non-transactional filesystem/process/network effects
- typed compensation-failure diagnostics, bounded retry, and explicit manual-intervention affordance
- no effect commit after lease loss, cancellation, or terminal claim

**Required security tests**

- spoofed _meta identity/capabilities
- replayed mutation with altered subject or principal
- same replay sent concurrently to different server instances and after restart
- retry the same stable claim before and after API/action/policy upgrade and prove no duplicate effect executes
- reuse the same idempotency key with a different subject and prove a typed conflict with no effect
- revoke scope before stored-result replay and prove disclosure is denied
- negotiate an incompatible result version and prove replay returns conflict/migration rather than an invalid payload
- kill or fail compensation mid-flight and prove the claim terminates as compensation-failed-needs-manual-intervention rather than hanging or falsely completing
- cross-workspace and cross-tenant access
- privilege escalation through presentation aliases
- generated CLI path and direct MCP path enforce the same authorization exactly once

### Thin-shim policy

- **Baseline:** Generate a manifest of every residual harness shim, source, packaged destination, capability reason, owner, issue, and expiry.
- **Budget:** The shim count is non-increasing. A new shim requires evidence that no standard surface exists plus an approved retirement issue.
- **Expiry:** Every shim has a dated reevaluation and a finite expiry or milestone; perpetual compatibility shims are rejected.
- **Current file-shim baseline:** 39 at `13cf9642b9c3ec5dec5a4bcfdbfc5ac6904a75f5`

| Shim category | Count |
|---|---:|
| runtimeSpecificSkillVariants | 18 |
| commandAliases | 16 |
| runtimeHookProjections | 5 |
| **Total** | **39** |

Per harness: claude=3, codex=4, copilot=4, cursor=4, generic=4, opencode=20.

**Proof**

- native standard artifact loads and behaves correctly on every conformant harness
- residual shim is packaged and loaded only on the harnesses that require it
- retired shim and its drift guard are absent from source, package, install destination, and user cache

### Generated outputs

### mcp-registration

- tools/list full input/output JSON Schemas
- server/discover capabilities
- protocol cache/TTL metadata
- structuredContent validators
### runtime-contracts

- TypeScript types
- Zod validators
- serializable action descriptors
- contract digest table
- compatibility registry
### implementation-binding-check

- ActionId -> exact handler
- ActionId -> summarizer hook
- ActionId -> presenter policy hook
- orphan/duplicate binding failures
### cli-client

- Commander/argv parser
- schema coercion
- in-process MCP contract call
- typed result decoding
- format/exit/dry-run templates
- help/examples
### standard-artifacts

- standard SKILL.md action references
- AGENTS.md contract vocabulary
- thin harness shims
- generated action documentation
### workflow-ir-bindings

- vendor-neutral namespaced ActionRef in Strategos.Contracts: namespace + contract ID + version range
- Exarchos-owned projection from ActionRef to stable Exarchos ActionId
- compile-time validation that workflow nodes reference available compatible actions
- generated gate/effect/evidence policy links outside the shared IR core
### proof-fixtures

- positive/negative schema fixtures
- error compatibility fixtures
- CLI golden snapshots
- MCP/CLI differential tests
- package/install contract digest checks

### Generated-artifact provenance

**Manifest fields**

- generatedPath
- generatorId and compiler version
- source contract paths and stable model IDs
- source schema/API/IR versions
- source contract digest
- generated content digest
- generation timestamp excluded from deterministic content

**File marker:** Every generated text/source file carries a machine-checked generated/do-not-edit header with generator ID and source contract digest.

**CI rules**

- Every declared generated-output path must appear in the generated manifest.
- Every manifest entry must be reproduced by a successful compiler invocation in CI.
- A generated file without provenance, a provenance entry without output, or a hand edit fails CI.
- Generator/source changes and generated outputs must land in the same commit.

**Negative tests**

- hand-edit a generated descriptor without changing TypeSpec
- add a manual file under a generated output directory
- remove a manifest entry while retaining output
- change generator version without regenerating
- reuse a stale source contract digest

### Independent implementation/security/effect oracle

**Purpose:** Prevent generated declarations and generated tests from agreeing on the same wrong protection/effect/output classification.

**Independent sources**

- TypeScript AST/call-graph extraction from implementation bindings and handlers
- server-owned authorization/guard registries
- effect occurrence/owner ledger
- explicit output-shape observation from hand-authored protocol fixtures
- pinned pre-codegen behavioral characterization corpus for every action
- packaged mutation probes that bypass or alter middleware/bindings

**Reconciled facts**

- exact handler
- pure/read-only versus effectful
- effect owner and capability class
- authorization requirement and scopes
- dry-run/idempotency/compensation behavior
- emittable output variants
- defaults/coercion semantics
- domain result semantics
- ordered effect and event trace

**Rule:** Unknown, conflicting, or generated-only classifications fail the build. The oracle is produced independently of the TypeSpec declarations and is reconciled before generated registration/client acceptance.

**Negative tests**

- mark an effectful handler pure
- remove an authorization guard while leaving the contract protected
- add an effect without an owner
- emit an undeclared degraded/capped output variant
- swap an implementation binding after generation
- swap two same-signature handlers and require semantic/effect-trace differential failure

### Generated client proof matrix

- API action denominator: 119
- API presentation-alias denominator: 8
- Host-command denominator: 3

**Required cases per API action**

- positive request/result
- input schema boundary/negative case
- authorization allow and deny where protected
- closed error mapping
- direct-dispatch/bypass mutation negative
- baseline plus capped/degraded/detail/paginated output variants when applicable
- effect-owner/dry-run/idempotency case when effectful

**Additional cases per effectful API action/owner**

- atomic claim-before-effect
- crash after claim before effect
- crash after effect-started before provider commit
- crash after provider effect before result persistence
- lease loss and stale fenced-worker commit rejection
- cancellation before and during effect
- cross-instance lease takeover
- effect-specific reconciliation or provider idempotency-token recovery
- compensation success and compensation-failed-needs-manual-intervention

**Required cases per presentation alias**

- alias resolves to exactly one ActionId
- same authorization/validation chain as direct MCP
- structured envelope equality
- human rendering/exit policy golden

**Required cases per host command**

- positive packaged-process invocation
- input/coercion boundary and closed error/exit mapping
- declared safety/effect/dry-run behavior
- proof that the command is genuinely host-local and does not shadow an API action
- build/install/server lifecycle failure path

**Independent oracles**

- hand-authored protocol fixtures not emitted by the code generator
- pinned legacy-to-generated differential corpus for every ActionId covering defaults, coercion, domain result, errors, and ordered effect/event traces
- mutation operators that bypass middleware, swap handler binding, weaken schema, or alter error mapping
- packaged binary/process tests

**Gate:** Coverage matrix is machine-reconciled across all API actions, presentation aliases, and host commands AND the independent implementation/security/effect oracle; unknown or conflicting classifications and missing cases fail CI, and representative subsets are forbidden.

### Implementation pipeline

| Phase | Work | Inputs | Outputs | Exit gate |
|---:|---|---|---|---|
| 0 | Authority and compatibility decisions | #1601/#1608 overlay; #1604 protocol migration; #1258 shared IR; current 119-action registry | approved meta-model; versioning rules; host-command exception list; compatibility policy | No unresolved authority for generated fields. |
| 1 | MCP 2026-07-28 migration | final protocol schemas and SDK | stateless adapter with no initialize/oninitialized authority; request-scoped authenticated context plus untrusted _meta hints; request-scoped roots/reverse-request routing; server/discover; full input/output schema support; durable cross-instance task ownership/expiry/tombstones/resumption; idempotent cancellation and restart/load-balancer semantics; new protocol/error/cache behavior | Tier-1 protocol conformance passes, two-client/fresh-instance tests prove no state leakage, and durable task/cancellation restart/load-balancer fixtures pass. |
| 2 | Contract compiler substrate | Exarchos TypeSpec; Strategos.Contracts generated schemas | JSON Schema; TS/Zod; descriptors; compatibility/error registries; digests; generated provenance manifest and file headers | Every current action and envelope round-trips losslessly; no z.unknown escape remains without an explicit open-world declaration; every generated output is compiler-produced and provenance-manifested in the same commit. |
| 3 | Runtime registry and implementation binding migration | generated descriptors; current handlers | generated TOOL_REGISTRY data; minimal binding map; deleted duplicate schema/description declarations | 119/119 actions have one contract and one handler; zero orphan or duplicate bindings. |
| 4 | CLI presentation client codegen | generated contract descriptors; presentation policy templates | argv/flags/help/rendering/exit mapping; in-process MCP contract invocation | No API action calls dispatch directly from CLI; instrumentation proves authorization, capability resolution, input validation, economy, handler binding, output validation, and error mapping execute exactly once; independent hand-authored protocol fixtures plus mutation/negative bypass tests pass. |
| 5 | Workflow IR and standards projections | stable ActionIds; Workflow Builder IR; standard artifact projections | typed action references in IR; standard SKILL.md/AGENTS.md/MCP artifacts; enumerated thin shims | No workflow or standard artifact embeds facade-specific call syntax; every shim has a capability reason and retirement condition. |
| 6 | Retirement and ratchets | generated clients/artifacts; migration fixtures | removed parity-as-authority paths; removed handwritten facade schema/help/rendering duplicates; CI codegen/compatibility/packaged-proof ratchets | Manual declarations cannot drift because they no longer exist or are mechanically checked policy hooks. |

### Hand-coded policy boundary

- Handler implementations and domain behavior
- Human rendering aesthetics and table/tree layout templates
- Secret redaction policy
- Exit-code policy for stable error classes
- Dry-run wording and confirmation UX
- Local-only launcher/bootstrap operations explicitly outside MCP action equivalence
- Summarizer/presenter hook implementations referenced by generated IDs

### Compatibility and versioning

**Version axes**

- MCP specification version
- Exarchos API contract version
- per-action contract version
- Strategos.Contracts workflow IR version
- package version
- build source SHA and contract digest

**Change classes**

- additive-compatible
- input-widening-additive
- input-tightening-breaking
- output-optional-addition-additive
- output-required-addition-or-removal-breaking
- breaking-error
- presentation-only
- retirement

**Behavior and policy change classes**

- authorization or required-scope change
- trusted safety annotation change
- pure/read-only versus effectful classification change
- effect owner/capability change
- idempotency or replay-window change
- dry-run or compensation semantic change
- task suitability/ownership/expiry/cancellation change
- evidence/auto-emission/admission policy change
- response-economy/cache/pagination behavior change

**Required compatibility artifacts**

- machine-readable schema diff
- migration/upcast rule
- deprecation/replacement metadata
- golden fixture update
- packaged compatibility test

**Negotiation and variance rules**

- Client declares supported MCP, Exarchos API, and per-action contract ranges.
- Server selects the highest mutually supported version or fails with a typed incompatible-version error; silent downgrade is forbidden.
- Every request and structured result carries the selected API/action version and contract digest.
- Upcasts are directional and occur at one generated read/dispatch seam; downcasts require an explicit lossless projection.
- Input compatibility is contravariant: widening accepted input is additive; tightening is breaking unless negotiated as a new version.
- Output compatibility is covariant: adding required output or removing output is breaking; additive optional output follows declared client tolerance.
- Error-union additions are breaking for closed clients unless the negotiated range declares open error handling.

**Canonical digest**

- RFC 8785 JSON Canonicalization Scheme for generated JSON contract artifacts
- SHA-256 over canonical bytes
- Digest includes imported Strategos.Contracts schema versions, codegen compiler version, authorization/effect/safety/idempotency/dry-run/task/evidence policies, and presentation policy IDs
- Digest is embedded in discovery, binary metadata, release manifest, and installed cache metadata

**Mixed-version matrix**

- old client / new server
- new client / old server
- mixed per-action version ranges
- unsupported version refusal
- input widening versus tightening
- output additive optional versus required/removal
- error-union evolution
- authorization/scope policy evolution
- effect/safety/idempotency/dry-run policy evolution
- task/cancellation/evidence policy evolution
- digest mismatch and stale generated client

### Security properties

- Server-trusted safety/effect policy is generated from reviewed contract authority, never client annotations.
- Custom extension annotations remain untrusted until admitted.
- Stateless request _meta identity/capabilities remain untrusted hints; authenticated transport/host context supplies the principal, scope, and server-derived capabilities threaded into evidence provenance.
- Generated CLI never bypasses the MCP authorization/validation handler.
- Error rendering redacts secrets without changing the structured error code or retry semantics.
- Contract digests are embedded in build/release/install metadata.

### Contract-compiler acceptance gates

1. Every external authority is pinned by exact spec/SDK/model revision and digest; floating latest inputs cannot generate releasable artifacts, and final-spec drift requires a reviewed migration diff.
2. Every CLI-visible ID is classified exactly once as API action, API presentation alias, or host command; host commands are limited to operations impossible through MCP.
3. All 119 built-in API actions and all host commands/presentation aliases are classified in the Exarchos API contract.
4. 119/119 API actions have total input, success, error, and output-envelope schemas.
5. 119/119 API actions have one exact implementation binding and declared pure/effectful classification.
6. CLI API commands are fully generated and invoke the MCP contract handler in-process; direct dispatch calls are absent outside the handler layer.
7. An independently generated implementation/security/effect/output oracle reconciles every action classification before registration/client acceptance; unknown or conflicting classifications fail.
8. Packaged instrumentation proves generated CLI and direct MCP paths traverse authentication, authorization, capability resolution, input validation, economy, handler binding, output validation, and error mapping exactly once.
9. Independent hand-authored protocol fixtures and mutation/negative bypass tests validate generated MCP/CLI surfaces.
10. A machine-reconciled proof matrix covers every generated API action and presentation alias across positive, schema-boundary, authorization, error, bypass, output-variant, and effect-policy cases; subset-only coverage cannot pass.
11. Every independently classified effectful ActionId/effect owner passes claim/effect/result crash-window, lease-loss, cancellation, takeover, reconciliation/idempotency-token, and compensation-failure cases.
12. Every ActionId passes a pinned legacy-to-generated semantic differential covering defaults/coercion, domain result, errors, and ordered effect/event traces; same-signature handler swaps fail.
13. The proof matrix covers every host command across packaged invocation, input/error/exit, safety/effect/dry-run, lifecycle failure, and host-local classification cases.
14. Every failure origin maps exactly once to a protocol error or typed Exarchos failure envelope; no thrown/pre-dispatch/adapter failure escapes the mapping.
15. Every stable error code has one typed payload, compatibility classification, CLI exit code, retry policy, and fixture.
16. Stateless multi-client/fresh-instance tests prove no session/root/capability/principal/task leakage and durable cross-instance task/cancellation recovery.
17. Every mutation uses a shared durable atomic replay/idempotency claim visible across instances/restarts, and stale fenced workers cannot commit effects or results after cancellation.
18. Replay claims bind the canonical full request, selected protocol/API/action versions, contract and policy digests, principal/scope, and effect subject; crash recovery covers every claim/effect window with leases, takeover, stored-result replay, reconciliation, or compensation.
19. Stable replay claim identity is version-independent; retries across contract/policy upgrades return stored results, typed conflicts, or explicit migrations and cannot execute a duplicate effect.
20. Stored-result replay re-evaluates current authorization and returns data only through a lossless projection to the negotiated schema; revoked access or incompatible versions return typed denial/conflict/migration.
21. A failed or interrupted compensation enters a typed compensation-failed-needs-manual-intervention terminal state with bounded retry and operator affordances; it cannot hang or be reported compensated.
22. Spoofed _meta, replay, cross-workspace/tenant access, and presentation-alias privilege escalation tests fail closed.
23. Workflow Builder IR uses vendor-neutral namespaced ActionRef values; the Exarchos projection rejects missing/incompatible actions at compile time.
24. Version negotiation, refusal, directional upcast/downcast, variance, mixed-version, and canonical digest fixtures pass.
25. Standard artifacts contain logical action references only; no facade-specific call syntax.
26. Every residual harness shim is enumerated, capability-justified, packaged, tested, assigned a finite expiry, and the shim budget never increases without an approved missing-standard exception.
27. Extension admission verifies signed provenance and immutable digest, enforces namespace/effect/schema/resource/isolation policy, supports revocation, and rejects TOCTOU swaps.
28. Extension signatures use the declared DSSE/canonical-payload trust profile with issuer/repository/ref policy, rotation/revocation, transparency or offline trust root, and anti-rollback verification.
29. Extension admission/execution fails closed on stale or unavailable revocation data and rejects revocation-epoch or clock rollback using signed checkpoints/trusted monotonic policy.
30. Extension admission resolves prevention/detection/advisory/unavailable spatial posture per harness and refuses or safely downgrades effect capabilities when the required posture is unavailable.
31. Every generated output carries a machine-checked provenance marker and manifest entry tied to a successful compiler invocation, source model IDs, compiler version, and contract digest in the same commit.
32. Codegen is deterministic and produces zero uncommitted drift.
33. MCP/CLI generated golden tests plus packaged differential tests pass.
34. Contract/API/build digests agree across server discovery, binary version metadata, release manifest, and installed cache.

### Explicit non-goals

- Generating handler business logic.
- Treating MCP protocol schemas alone as the full Exarchos API contract.
- Encoding executable functions inside TypeSpec or JSON Schema.
- Treating client-controlled request _meta as authentication or authorization.
- Embedding Exarchos-specific ActionIds directly in the vendor-neutral Strategos IR core.
- Claiming launcher-based filesystem confinement for INV-11.
- Generating bespoke per-harness artifacts where a standard exists.
- Making Exarchos an MCP client of Basileus.

## Codebase profile

| Metric | Value |
|---|---:|
| Repository files | 2826 |
| Repository bytes | 34541551 |
| Code files | 1647 |
| TypeScript production files | 627 |
| TypeScript test files | 905 |
| Production TypeScript lines | 155766 |
| Test TypeScript lines | 270066 |
| Test-to-production line ratio | 1.73 |
| Production files >=500 lines | 71 |
| Production files >=1,000 lines | 21 |
| Enforcer primaries | 22 |
| Blocking enforcers | 17 |
| Advisory enforcers | 3 |
| Retired enforcers | 2 |

### Domain size

| Domain | Files | Text lines |
|---|---:|---:|
| `servers/exarchos-mcp/src` | 1250 | 375418 |
| `src` | 85 | 21399 |
| `scripts` | 135 | 26479 |
| `skills-src` | 108 | 15501 |
| `commands` | 18 | 188 |
| `rules` | 1 | 10 |
| `test` | 63 | 9395 |
| `docs` | 615 | 127235 |

### Largest production ownership surfaces

Line count is a review/decomposition signal, not an automatic defect.

| File | Lines |
|---|---:|
| `servers/exarchos-mcp/src/registry.ts` | 4205 |
| `servers/exarchos-mcp/src/event-store/schemas.ts` | 4124 |
| `servers/exarchos-mcp/src/storage/sqlite-backend.ts` | 2700 |
| `src/build-skills.ts` | 2239 |
| `servers/exarchos-mcp/src/views/tools.ts` | 2224 |
| `servers/exarchos-mcp/src/workflow/tools.ts` | 2033 |
| `servers/exarchos-mcp/src/verbs/worktree/manager.ts` | 1892 |
| `servers/exarchos-mcp/src/verbs/team/prepare-delegation.ts` | 1674 |
| `servers/exarchos-mcp/src/adapters/cli.ts` | 1576 |
| `src/install-skills.ts` | 1555 |
| `servers/exarchos-mcp/src/workflow/playbooks.ts` | 1546 |
| `servers/exarchos-mcp/src/event-store/atomic-appender.ts` | 1419 |
| `servers/exarchos-mcp/src/workflow/compensation.ts` | 1334 |
| `servers/exarchos-mcp/src/task-store/event-sourced-task-store.ts` | 1316 |
| `servers/exarchos-mcp/src/dispatch/core/dispatch.ts` | 1097 |
| `servers/exarchos-mcp/src/dispatch/core/onboarding/reconcile.ts` | 1069 |
| `servers/exarchos-mcp/src/verbs/team/prune-stale-workflows.ts` | 1061 |
| `servers/exarchos-mcp/src/workflow/guards.ts` | 1060 |
| `servers/exarchos-mcp/src/workflow/state-machine.ts` | 1044 |
| `servers/exarchos-mcp/src/views/workflow-state-projection.ts` | 1019 |
| `servers/exarchos-mcp/src/verbs/gates/mutation-adequacy.ts` | 1016 |
| `servers/exarchos-mcp/src/projections/rehydration/reducer.ts` | 988 |
| `servers/exarchos-mcp/src/verbs/tasks/task-decomposition.ts` | 973 |
| `servers/exarchos-mcp/src/verbs/merge/merge-orchestrate.ts` | 951 |
| `servers/exarchos-mcp/src/event-store/store.ts` | 943 |
| `servers/exarchos-mcp/src/verbs/onboard/install.ts` | 857 |
| `servers/exarchos-mcp/src/verbs/pure/static-analysis.ts` | 856 |
| `servers/exarchos-mcp/src/verbs/pure/execute-merge.ts` | 818 |
| `servers/exarchos-mcp/src/verbs/gates/plan-coverage.ts` | 812 |
| `servers/exarchos-mcp/src/workflow/state-store.ts` | 810 |

## Native gate and validation health

The structural checks below ran against the extracted candidate snapshot
`13cf9642b9c3ec5dec5a4bcfdbfc5ac6904a75f5` at
`C:\Users\salusreed\.copilot\session-state\8cbb8868-4652-461a-8629-4703a12d83c9\files\candidate-baseline`. The archive
contains no `node_modules`; dependency-backed wrappers are explicitly marked
not run.

| Check | Status | Result |
|---|---|---|
| gate-runner-ownership | pass | check-gate-runner-ownership: clean — 84 production finding(s) have exact typed owners. |
| enforcer-wiring | pass | check-enforcer-wiring: clean — 22 primaries dispositioned. |
| event-store-composition-root | pass | -- |
| query-upcast-choke-point | pass | -- |
| no-state-json | pass | -- |
| single-workflow-fold | pass | -- |
| module-intent | fail | check-module-intent: 1 dead-in-prod module(s) lack valid intent (DR-7). \| System.Management.Automation.RemoteException \| views/gate-reliability-view.ts \| dead-in-prod (0 production importers) with no RESERVED(issue, owner, expires) header and no allowlist class \| System.Management.Automation.RemoteException \| Every production module with zero production importers must either carry a \| RESERVED(issue, owner, expires) header with a future expiry, belong to a declared \| allowlist class (test-infra / build-shim / type-test entrypoint), or be deleted. |
| type-debt | fail | check-type-debt: FAIL (over-budget): 3 file(s) exceed their baselined `as unknown as` budget: \| servers/exarchos-mcp/src/storage/sqlite-backend.ts budget=2 actual=3 \| servers/exarchos-mcp/src/workflow/cleanup.ts budget=1 actual=2 \| servers/exarchos-mcp/src/workflow/tools.ts budget=7 actual=9 \| check-type-debt: FAIL (unbaselined-debt): 1 file(s) have `as unknown as` casts with no entry in type-debt-baseline.json: \| servers/exarchos-mcp/src/workflow/cancel.ts actual=1 \| System.Management.Automation.RemoteException \| Fix the casts (preferred) or run `node scripts/check-type-debt.mjs --update` to record a deliberate, reviewed increase. |
| wlm-wiring | pass | WLM wiring gate: clean. |
| windows-portability | pass | Windows-portability gate: clean. |
| check-begin-immediate-substrate | pass | OK: no immediate-transaction substrate leaks found in /c/Users/salusreed/.copilot/session-state/8cbb8868-4652-461a-8629-4703a12d83c9/files/candidate-baseline |
| check-coverage-ratchet | blocked | check-coverage-ratchet: FAIL CLOSED — coverage-summary.json not found at C:\Users\salusreed\.copilot\session-state\8cbb8868-4652-461a-8629-4703a12d83c9\files\candidate-baseline\servers\exarchos-mcp\coverage\coverage-summary.json |
| check-withsession-idempotency | pass | check-withsession-idempotency: OK (all .withSession( call sites are compliant) |
| lint-test-first-drift | pass | { \| "findings": [], \| "advisory": false \| } |
| check-prefix-fingerprint | blocked | ERR_MODULE_NOT_FOUND while resolving the candidate fingerprint CLI dependency graph through the linked authoring node_modules; missing=yazl; retry=Install candidate snapshot dependencies from its package-lock in an isolated environment, then rerun the wrapper without a cross-checkout node_modules junction. |
| check-prose-lint | pass | check-prose-lint: OK (no violations) |
| golden-fixture-note | not-run | Diff-dependent PR-body gate; candidate snapshot has no pull-request diff/body context. |

### Candidate gate provenance

| Command | Started (UTC) | Ended (UTC) | Exit | Host / dependency state |
|---|---|---|---:|---|
| `node scripts/check-gate-runner-ownership.mjs` | 2026-07-24T05:12:29.5883622+00:00 | 2026-07-24T05:12:39.1979999+00:00 | 0 | Windows_NT; git archive without node_modules |
| `node scripts/check-enforcer-wiring.mjs` | 2026-07-24T05:12:39.2540115+00:00 | 2026-07-24T05:12:39.5804189+00:00 | 0 | Windows_NT; git archive without node_modules |
| `node scripts/check-event-store-composition-root.mjs` | 2026-07-24T05:12:39.6226062+00:00 | 2026-07-24T05:12:39.9844074+00:00 | 0 | Windows_NT; git archive without node_modules |
| `node scripts/check-query-upcast-choke-point.mjs` | 2026-07-24T05:12:40.0303331+00:00 | 2026-07-24T05:12:40.3569872+00:00 | 0 | Windows_NT; git archive without node_modules |
| `node scripts/check-no-state-json.mjs` | 2026-07-24T05:12:40.3990511+00:00 | 2026-07-24T05:12:40.7376513+00:00 | 0 | Windows_NT; git archive without node_modules |
| `node scripts/check-single-workflow-fold.mjs` | 2026-07-24T05:12:40.7799163+00:00 | 2026-07-24T05:12:41.1094436+00:00 | 0 | Windows_NT; git archive without node_modules |
| `node scripts/check-module-intent.mjs` | 2026-07-24T05:12:41.1513002+00:00 | 2026-07-24T05:12:56.6726721+00:00 | 1 | Windows_NT; git archive without node_modules |
| `node scripts/check-type-debt.mjs` | 2026-07-24T05:12:56.7152281+00:00 | 2026-07-24T05:12:57.5878778+00:00 | 1 | Windows_NT; git archive without node_modules |
| `node scripts/check-wlm-wiring.mjs` | 2026-07-24T05:12:57.6291133+00:00 | 2026-07-24T05:12:59.4682040+00:00 | 0 | Windows_NT; git archive without node_modules |
| `node scripts/check-windows-portability.mjs` | 2026-07-24T05:12:59.5101410+00:00 | 2026-07-24T05:13:00.4731165+00:00 | 0 | Windows_NT; git archive without node_modules |
| `bash scripts/check-begin-immediate-substrate.sh` | 2026-07-24T05:47:52.6400517+00:00 | 2026-07-24T05:48:28.7016856+00:00 | 0 | Windows_NT; git archive without node_modules |
| `node scripts/check-coverage-ratchet.mjs` | 2026-07-24T05:48:28.7146750+00:00 | 2026-07-24T05:48:28.8315006+00:00 | 2 | Windows_NT; git archive without node_modules |
| `bash scripts/check-withsession-idempotency.sh` | 2026-07-24T05:48:28.8329604+00:00 | 2026-07-24T05:48:30.6356295+00:00 | 0 | Windows_NT; git archive without node_modules |
| `node scripts/lint-test-first-drift.mjs` | 2026-07-24T05:48:30.6365703+00:00 | 2026-07-24T05:48:33.3443687+00:00 | 0 | Windows_NT; git archive without node_modules |
| `node scripts/check-prefix-fingerprint.mjs` | 2026-07-24T06:14:53.7648417+00:00 | 2026-07-24T06:14:57.9367767+00:00 | 2 | Windows_NT; candidate archive with junction to authoring node_modules; package-lock unchanged across audited range |
| `node scripts/check-prose-lint.mjs` | 2026-07-24T05:48:59.2701189+00:00 | 2026-07-24T05:48:59.8003262+00:00 | 0 | Windows_NT; candidate archive with junction to authoring node_modules; package-lock unchanged across audited range |
| `node scripts/check-golden-fixture-note.mjs` | 2026-07-24T05:49:00.0000000+00:00 | 2026-07-24T05:49:00.0000000+00:00 | null | Windows_NT; git archive without PR event/diff context |

### Test/toolchain state

- **Typecheck:** pass — `npm run typecheck --silent` at authoring HEAD `6985fea1140d04191205b4e0b5d8bcd8b16c47eb`, cwd `C:\Work\exarchos`, 2026-07-24T04:52:26.6544050+00:00 to 2026-07-24T04:52:37.4761824+00:00
- **Full suite:** `npm run test:run --silent` at authoring HEAD `6985fea1140d04191205b4e0b5d8bcd8b16c47eb`, cwd `C:\Work\exarchos`, 2026-07-24T04:53:36.6203760+00:00 to 2026-07-24T04:53:59.9679675+00:00; 113/120 test files passed and 1037/1075 tests passed
- **Environment blockers:** Bun missing from PATH for build-binary and event-replay suites; Live-tree checks intermittently exceed the existing 5-second test timeout under the full parallel suite
- **Run variability:** Two runs on the same HEAD produced different timeout-driven failure counts. Earlier: 11 failed files / 9 failed tests; later: 4 / 2.

The suite result is evidence about harness health, not evidence that the audit
document changes broke product code. It validates the authoring checkout and
host harness, not the candidate archive. The remediation backlog separates
environment/toolchain work from product defects.

## Structural inventory coverage

| Inventory | Rows | Closed | Partial | Open | Indeterminate |
|---|---:|---:|---:|---:|---:|
| Contracts/public surfaces | 275 | 64 | 210 | 0 | 1 |
| Effects/state | 24 | 3 | 19 | 1 | 1 |
| Ship surface | 264 | 3 | 35 | 226 | 0 |
| Artifacts/install/cache | 19 | 5 | 7 | 3 | 4 |
| v3 lowering | 30 | 2 | 18 | 9 | 1 |
| **Total** | **612** | **77** | **289** | **239** | **7** |

### Effect occurrence reconciliation

| Candidate class | Occurrences |
|---|---:|
| filesystem | 155 |
| process | 86 |
| event-append | 93 |
| hook-dispatch | 2 |
| channel-push | 2 |
| network | 1 |
| **Total** | **339** |

- Concrete owner-row mappings: 170
- Indeterminate placeholder-owner mappings requiring targeted classification: 131
- Total owner-row mappings (concrete + placeholder): 301
- Explicit build/CI exclusions: 38
- Unclassified occurrences: 0

## Remediation program sequence

| Program | Priority | Outcome | Items | Dependencies | Target state |
|---|---|---|---:|---|---|
| PROGRAM-01 | P0 | Restore authoritative state and projection truth | 4 | -- | Atomic event/stream state, deterministic startup repair, blocking projection degradation, and protected generic append. |
| PROGRAM-02 | P0 | Restore blocking workflow and native quality gates | 5 | PROGRAM-01 | Delegation, integration, completion, type-debt, and module-intent gates are truthful and green on the audited snapshot. |
| PROGRAM-03 | P1 | Compile the Exarchos API contract into MCP, CLI, Workflow IR, and standard artifacts | 12 | PROGRAM-01 | The MCP protocol, Strategos shared IR, and Exarchos product policies compose into one versioned API contract that generates runtime descriptors, CLI clients, workflow action references, standards artifacts, compatibility fixtures, and extension boundaries. |
| PROGRAM-04 | P1 | Consolidate effect ownership, idempotency, and rollback | 11 | PROGRAM-01 | Filesystem, install, VCS, worktree, onboarding, artifact, and cancellation effects use typed owners with repair/rollback proof. |
| PROGRAM-05 | P1 | Bind builds, releases, installed caches, and packaged proof to source identity | 11 | PROGRAM-03, PROGRAM-04 | Reproducible source-SHA-linked artifacts and exact packaged proof cover public actions and generated projections. |
| PROGRAM-06 | P1 | Repair workflow planning and verification semantics | 9 | PROGRAM-01, PROGRAM-02 | Adequacy, coverage, decomposition, risk metadata, merge guidance, and toolchain behavior match lifecycle intent. |
| PROGRAM-07 | P2 | Complete v3 cutover, module boundaries, and ratchet retirement | 9 | PROGRAM-01, PROGRAM-02, PROGRAM-03, PROGRAM-04, PROGRAM-05, PROGRAM-06 | Open lowerings, legacy guards, advisory controls, oversized ownership surfaces, and audit-only inventories have explicit exits. |

### Priority and scope mix

| Priority | Items | Small | Medium | Large |
|---|---:|---:|---:|---:|
| P0 | 7 | 2 | 5 | 0 |
| P1 | 40 | 8 | 16 | 16 |
| P2 | 14 | 3 | 7 | 4 |

### Backlog by domain

| Domain | Items | P0 | P1 | P2 |
|---|---:|---:|---:|---:|
| api-contract-codegen | 10 | 0 | 10 | 0 |
| artifacts-packaging-proof | 12 | 0 | 10 | 2 |
| baseline-native-gates | 5 | 2 | 1 | 2 |
| contracts-public-surface | 4 | 0 | 2 | 2 |
| state-effects | 14 | 2 | 11 | 1 |
| workflow-gates-quality | 16 | 3 | 6 | 7 |

## Systemic findings

### artifacts-packaging-proof

- **SYS-01** — Zero tracked dist files exist at the pinned candidate despite fully specified bundle and 5-target binary build pipelines, so no build/package digest can be tied to source SHA 13cf9642.
- **SYS-02** — Compiled-binary/process packaged proof is nearly absent: only 4 of 119 registered MCP actions and 1 of 11 standalone CLI commands have an exact process-test invocation; source unit tests are not credited.
- **SYS-03** — Installed artifacts (binary, skill cache, plugin cache) cannot be bound to the pinned candidate: version strings match but no build/source SHA travels with any installed artifact, and installed skill content diverges byte-for-byte from candidate source.
- **SYS-04** — Generated artifacts (skills, aliases, agents, hooks, runtimes) are all guarded for repo-internal drift, but none of these guards extend to proving the shipped/installed artifact was produced from and matches the candidate generator output.
- **SYS-05** — Release/publication provenance relies on SHA-512 checksums and npm OIDC trusted publishing only; no signed, source-SHA-linked release manifest exists that an installer or user could verify against the pinned commit.

### contracts-public-surface

- **SF-01** — Public surface (119 MCP actions, 11 CLI commands, CLI help, MCP tool descriptions, skills, aliases, agents, hooks, runbooks, workflow/config schemas, docs) is hand-maintained in parallel representations with no single versioned IDL that lowers to all of them; mechanical guards check some pairwise projections but not one-contract generation.
- **SF-02** — Packaged/process proof is sparse: only 4/119 built-in actions and 1/11 standalone CLI commands have exact compiled-binary/process proof; source handlers and registry/adapter tests are not credited as packaged reachability proof.
- **SF-03** — Generated projections (skills, aliases, agents, hooks, manifests, docs - 264 ship-surface rows) have source/generator links but no located installed-artifact containment proof; the accessible installed skill cache disagrees byte-for-byte with all 3 overlapping candidate Copilot skills.
- **SF-04** — Artifact/build identity stops at semantic version (2.12.0-preview.3 across package/plugin/project manifests); installed binary SHA-256 cannot be tied to the candidate commit or a release checksum, and dist/ is untracked in both trees so no build-artifact digest exists to bind.
- **SF-05** — Effect ownership is closed only for gate evidence/ownership; filesystem, installer (posix/powershell download+promote), git/VCS worktree-merge, onboarding, and cache-write effects remain locally owned with provider-specific rollback/idempotency, not one effect algebra.
- **SF-06** — Projection integrity (event-store to workflow-fold projections) has no proof that stream/event/projection sequence disagreement emits a blocking degradation state or that consumers fail safe; CB-8 (stale/contradictory projections) remains open.
- **SF-07** — The consumer-supplied custom-tool extension boundary is indeterminate: there is no declared extension manifest/handshake enumerating custom tools/schemas, so the trust and output-contract boundary between built-in and consumer-supplied tools is unproven.
- **SF-08** — v3 cutover ledger has 9 open and 18 partial mechanisms of 30 total (9 code bugs CB-1..CB-9, 6 doc issues DOC-1..DOC-6 all mapped but unresolved), meaning contract/public-surface remediation must sequence against an already-tracked, unfinished migration rather than a stable target architecture.

### state-effects

- **SYS-001** — Effect ownership is locally named and locally fail-closed for many paths, but 19 of 24 owner rows remain partial and the 339-occurrence ledger still maps 131 candidates to the indeterminate boundary; there is no repository-wide effect algebra or atomic rollback proof.
- **SYS-002** — Projection staleness/contradiction (CB-8) is structurally downstream of unresolved event-store sequence/version atomicity (CB-1); fixing the append path alone does not retire the open projection-degradation finding.
- **SYS-003** — The gate ownership census (scripts/check-gate-runner-ownership.mjs) is the only closed, CI-enforced chokepoint in the effect inventory, yet it coexists with 25 direct-gate-emitter, 6 manual-gate-event, and 17 playbook-observation bypasses that remain executable in production and are only classified, not retired.
- **SYS-004** — The same defect class (direct filesystem/registry overwrite without atomic staged-promotion and rollback) recurs across six independently owned effect sites: CLI config write, MCP config write, copy/install-skills, POSIX installer promote, PowerShell installer promote, and onboarding install.
- **SYS-005** — Every located v2.12 mechanism has code evidence, but 28 of 30 lowering rows remain non-closed: 18 partial, 9 open, and 1 indeterminate. The gap is cutover/backward-compatibility proof, not mechanism absence.
- **SYS-006** — Dynamic and external effect surfaces (custom tools, injected providers, runtime-specific shells, and 15 frozen legacy-guard-shell reservations) are explicitly out of the ownership census reach, so no repository-wide closed-effect claim is possible regardless of internal fixes.

### workflow-gates-quality

- **SF-1** — Verification work is duplicated 2-3x per task with no single owner: agents self-test/typecheck, the task-completion runbook reruns adequacy/contract/mock/static/integration gates, and the lead reruns targeted tests again after merge.
- **SF-2** — Planner-supplied risk/boundary metadata always wins over heuristics with no plausibility check, so one bad blanket stamp (17/17 high+boundaryTouching) silently maximizes verification cost for every task instead of triggering a challenge.
- **SF-3** — One non-atomic event-append root cause (stream-version row vs events.sequence divergence) cascades into task completion failure, checkpoint failure, and stale/contradictory projections (pipeline, readiness) with no fail-loud degraded-state signal.
- **SF-4** — Skill documentation (SKILL.md files) is handwritten prose describing action behavior rather than generated from the actions registered description/schema, so it silently drifts from runtime reality (worktree creation claim, path convention, threshold scale, merge capability posture).
- **SF-5** — Plan-time coverage gates conflate the plan declares this artifact with this artifact already exists on disk, producing false negatives for spec structures and test files that implementation tasks are expected to create.
- **SF-6** — The independent structural-principles assessment corroborates a repository-wide pattern of advisory/audit-mode controls that look like enforcement but do not block: 9 of 13 invariant-catalog entries with explicit modes are audit-only, mutation adequacy runs in observe mode, INV-6 lint swallows its exit code, and benchmark/capability-eval regressions are non-blocking.
- **SF-7** — Module boundary enforcement is narrow: Dependency Cruiser expresses one domain-to-adapter rule, not per-module ownership, allowed-dependency, or effect-port contracts; many handlers accept broad contexts (DispatchContext, EventStore) rather than minimal ports, so declared module contracts understate true effect surface.
- **SF-8** — Test infrastructure is workspace-fragmented rather than a single closed harness: root and servers/exarchos-mcp maintain separate vitest configs with different bun:sqlite handling (real Bun binary vs Node shim alias) and different per-project timeout defaults, so pass/fail and timeout behavior depends on which toolchain/workspace executes a suite rather than on product logic alone.

## Positive structural patterns

### artifacts-packaging-proof

- Semantic version identity (2.12.0-preview.3) is enforced identically across package.json, manifest.json, and .claude-plugin/plugin.json via scripts/sync-versions.sh --check (npm run version:check), and the installed binary reports the matching version.
- Repository-side generation drift is actively guarded for skills, command aliases, hooks, and runtimes (skills:guard, hooks:guard, runtimes:guard), keeping source-to-generated-output identity closed within the repo.
- The release workflow enumerates a deterministic 10-asset manifest (5 cross-compiled binaries + 5 SHA-512 sidecars) with an explicit count guard that aborts publication on drift.
- A new gate-runner ownership census control (scripts/check-gate-runner-ownership.mjs) was added at the candidate and passes with 84 exactly-typed owned occurrences, closing a prior ownership gap.

### contracts-public-surface

- All 119 registered actions declare explicit action-level output schemas in the pinned tree (TypeScript AST-verified cardinality 119/119), giving a firm base to lower from.
- Gate-effect ownership is mechanically census-checked: scripts/check-gate-runner-ownership.mjs accounts for exactly 84 production occurrences across 7 typed dispositions and passes as a blocking control.
- Gate evidence append is awaited and idempotency-keyed before returning a success carrier, giving a fail-closed pattern to extend to other effect classes.
- Repository content generation already has guards for several projections (skills, aliases, agents, hooks, runtime config, version sinks), showing generation/drift-check machinery exists and can be extended rather than invented from scratch.

### state-effects

- Gate ownership census gives exactly one typed disposition to all 84 detected gate-related production occurrences and fails npm run validate on drift.
- Event append now wraps stream-version update and event insert in one BEGIN IMMEDIATE SQLite transaction, and gate evidence append is idempotency-keyed by evidenceId with an explicit sameOperation dedup check before any new evidence is written.
- Content-addressed artifact store performs atomic temp-write/publish and verifies a SHA-256 digest on every read, giving artifact effects a self-checking invariant.
- Rehydration envelope deserialization enforces DR-18: no silent version fallback, only a typed InvalidEnvelopeError, and this is regression-tested.

### workflow-gates-quality

- check_contract_drift degrades to an advisory pass (not a false block) when no contract tool resolves in a repo without a schema boundary, and the runbook comment documents this intentional degrade path (INV-4).
- check_mock_boundary is deliberately advisory (onFail: continue) with a documented reason escape hatch instead of hard-blocking legitimate unowned-mock cases (SIV-4, #1530).
- scripts/enforcer-wiring-manifest.json requires every enforcement script to declare a disposition (gating/advisory/retired) with rationale and verifies CI behavior matches the declaration, preventing false claims of enforcement even while advisory controls remain incomplete.
- check_integration_suite already models load-cascade failures (a file failing at import) as counted failures rather than an invisible 0/0, and already carries a parseError/parseFailureKind distinction (spawn-failure vs shape-mismatch) that a fix can build on.
- Dependency Cruiser, an import-cycle test with positive controls, and an event-store composition-root script already provide genuine mechanical ratchets for the seams they cover, giving module-boundary remediation a template to extend rather than invent.

## Current structural maturity

This is a baseline score, not a commit delta.

| Principle | Score | Current finding | Evidence / backlog |
|---|---:|---|---|
| 1. Generate every boundary from one contract | 2/4 | 119 built-in action schemas are explicit, but public surfaces remain parallel representations. | contracts:contract.output-schema-enforcement; PROGRAM-03 |
| 2. Make domain behavior algebraic and effects explicit | 3/4 | Proof ADTs and gate evidence are strong; non-gate effects remain locally owned. | effects:gate.evidence-append; PROGRAM-04 |
| 3. Modularize around independently provable units | 2/4 | Mechanical seams exist, but 71 production files exceed 500 lines and module contracts are not universal. | codebase-metrics:largeProductionFiles; BASE-003 |
| 4. Make integration completeness a graph property | 2/4 | The audit builds a graph, but the shipped code does not generate or gate on it. | ship:SHIP-F001; CTR-013 |
| 5. Assign every claim to the cheapest sound proof | 3/4 | The verification ladder is systematic, but several gates are mistimed or unusable and packaged proof is sparse. | PROGRAM-02; PROGRAM-06 |
| 6. Make every change proof-carrying and bounded | 2/4 | Gate evidence is durable; artifact identity and end-to-end packaged proof are incomplete. | PROGRAM-01; PROGRAM-05 |
| 7. Convert discoveries into structural ratchets | 3/4 | 17 gates are blocking and dispositions are explicit; advisory exits and native gate failures remain. | codebase-metrics:enforcement; PROGRAM-07 |
| **Total** | **17/28** | **Systematic local structure; global proof remains open** | **Programs 01-07** |

### Principle 1: Generate every boundary from one contract

**Current score:** 2/4

- **Assessment:** 119 built-in action schemas are explicit, but public surfaces remain parallel representations.
- **Evidence / backlog:** contracts:contract.output-schema-enforcement; PROGRAM-03

### Principle 2: Make domain behavior algebraic and effects explicit

**Current score:** 3/4

- **Assessment:** Proof ADTs and gate evidence are strong; non-gate effects remain locally owned.
- **Evidence / backlog:** effects:gate.evidence-append; PROGRAM-04

### Principle 3: Modularize around independently provable units

**Current score:** 2/4

- **Assessment:** Mechanical seams exist, but 71 production files exceed 500 lines and module contracts are not universal.
- **Evidence / backlog:** codebase-metrics:largeProductionFiles; BASE-003

### Principle 4: Make integration completeness a graph property

**Current score:** 2/4

- **Assessment:** The audit builds a graph, but the shipped code does not generate or gate on it.
- **Evidence / backlog:** ship:SHIP-F001; CTR-013

### Principle 5: Assign every claim to the cheapest sound proof

**Current score:** 3/4

- **Assessment:** The verification ladder is systematic, but several gates are mistimed or unusable and packaged proof is sparse.
- **Evidence / backlog:** PROGRAM-02; PROGRAM-06

### Principle 6: Make every change proof-carrying and bounded

**Current score:** 2/4

- **Assessment:** Gate evidence is durable; artifact identity and end-to-end packaged proof are incomplete.
- **Evidence / backlog:** PROGRAM-01; PROGRAM-05

### Principle 7: Convert discoveries into structural ratchets

**Current score:** 3/4

- **Assessment:** 17 gates are blocking and dispositions are explicit; advisory exits and native gate failures remain.
- **Evidence / backlog:** codebase-metrics:enforcement; PROGRAM-07

## Target-state acceptance gates

The next baseline may claim structural closure only when all of the following are
mechanically true:

1. Candidate-native type-debt and module-intent gates pass.
2. Event append, stream version, and projection sequence cannot diverge; startup repair is proven under concurrency.
3. Every stale/contradictory projection produces a durable blocking degradation signal.
4. Delegation, adequacy, integration, completion, and coverage gates pass the dogfood reproductions without workarounds.
5. The MCP adapter implements the final 2026-07-28 stateless contract and exposes full input/output schemas, discovery, Tasks/cancellation, cache, and compatibility semantics.
6. Every API action is generated from the Exarchos API contract with one exact implementation binding; the CLI invokes the MCP contract handler in-process and has no direct dispatch path.
7. Workflow Builder IR references stable generated ActionIds and rejects missing, incompatible, or deprecated actions at compile time.
8. Skills/instructions emit standard-conformant artifacts once; every residual harness shim is capability-justified and has a retirement condition.
9. INV-11 lifecycle ownership is proven through launcher/WLM events, while spatial confinement is reported separately per harness and never inferred from launcher cwd/worktree ownership.
10. Every public action class and projection loader has compiled/process or installed-artifact proof.
11. Build/release/install/cache identity is tied to source SHA, API contract digest, and a verifiable signed manifest.
12. Filesystem, install, VCS, worktree, onboarding, and external effects have typed owners with idempotency and repair/rollback proof.
13. The static effect occurrence ledger has zero indeterminate owner mappings.
14. Every advisory/legacy control meets its promotion or retirement condition.
15. The v3 lowering ledger has no open or indeterminate mechanisms.

## P0 implementation backlog

### BASE-001 — Restore the candidate type-debt gate to green

**Priority:** P0 · **Program:** PROGRAM-02 · **Risk:** medium · **Scope:** medium

**Problem:** The pinned candidate fails its own blocking type-debt gate: three files exceed baselined `as unknown as` budgets and workflow/cancel.ts is unbaselined.

**Impact:** The candidate cannot claim structurally enforced type safety while a gating register fails on the exact snapshot under audit.

**Proposed change:** Eliminate the excess casts with typed decoding/narrowing at the owning boundaries. Update the baseline only for a deliberate residual after code review.

**Evidence**
- candidate check-type-debt: storage/sqlite-backend.ts budget=2 actual=3
- candidate check-type-debt: workflow/cleanup.ts budget=1 actual=2
- candidate check-type-debt: workflow/tools.ts budget=7 actual=9
- candidate check-type-debt: workflow/cancel.ts unbaselined actual=1

**Target files**
- `servers/exarchos-mcp/src/storage/sqlite-backend.ts`
- `servers/exarchos-mcp/src/workflow/cleanup.ts`
- `servers/exarchos-mcp/src/workflow/tools.ts`
- `servers/exarchos-mcp/src/workflow/cancel.ts`
- `scripts/type-debt-baseline.json`

**Acceptance proof**
- node scripts/check-type-debt.mjs exits 0 on the candidate branch
- Focused tests cover each replacement narrowing path
- No new `as any` casts or widened public carriers

**Dependencies:** None

### BASE-002 — Resolve the dead-in-production gate reliability view

**Priority:** P0 · **Program:** PROGRAM-02 · **Risk:** medium · **Scope:** small

**Problem:** The pinned candidate module-intent gate reports views/gate-reliability-view.ts with zero production importers and no valid RESERVED/allowlist intent.

**Impact:** The candidate presents gate reliability as a closure gain, but the implementation is not selected by production and also breaks a blocking module-intent ratchet.

**Proposed change:** Either wire the view into the production view registry/composite with a public/read-model consumer, or delete/reserve it with an issue, owner, expiry, and removal proof.

**Evidence**
- candidate check-module-intent: views/gate-reliability-view.ts dead-in-prod
- servers/exarchos-mcp/src/views/gate-reliability-view.ts

**Target files**
- `servers/exarchos-mcp/src/views/gate-reliability-view.ts`
- `servers/exarchos-mcp/src/views/composite.ts`
- `servers/exarchos-mcp/src/registry.ts`
- `scripts/check-module-intent.mjs`

**Acceptance proof**
- node scripts/check-module-intent.mjs exits 0
- If wired: process/adapter test invokes the production view action
- If removed: no registry, documentation, or test references remain

**Dependencies:** None

### EFF-001 — Prove event-store append atomicity under concurrency and add startup sequence/version repair

**Priority:** P0 · **Program:** PROGRAM-01 · **Risk:** high · **Scope:** medium

**Problem:** CB-1 reproduced events.sequence / streams.version divergence in the dogfood run (Expected sequence 236, actual 235). The candidate added a BEGIN IMMEDIATE transaction (M017) as a fix candidate, but the audit and dogfood report agree the divergence path is not proven closed under concurrent multi-instance appends, and no startup repair reconciles an already-diverged stream.

**Impact:** Diverged sequence/version rows block task completion, task failure, checkpoints, team lifecycle events, and state reconciliation (dogfood CB-1 impact statement); every downstream projection (CB-8) inherits the corruption.

**Proposed change:** Add a multi-process EventStore integration test that runs two separate store instances concurrently appending to the same stream and asserts no UNIQUE/sequence-mismatch escape; add a startup repair routine that compares streams.version against MAX(events.sequence) per stream and either reconciles deterministically or fails loud before serving traffic.

**Evidence**
- 2026-07-21-phase-gate-v212-dogfood.md:179-207 (CB-1)
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/effects.json#rows[event-store.authoritative-append] (disposition: partial)
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/v3-lowering.json#rows[M017,M021] (disposition: partial/indeterminate)
- 13cf9642:servers/exarchos-mcp/src/event-store/atomic-appender.ts

**Target files**
- `servers/exarchos-mcp/src/event-store/atomic-appender.ts`
- `servers/exarchos-mcp/src/storage/sqlite-backend.ts`
- `servers/exarchos-mcp/src/event-store/multi-process.test.ts`

**Acceptance proof**
- New/extended multi-process.test.ts triggers concurrent competing appends and asserts a single consistent (sequence, version) outcome with no silent divergence
- Startup repair unit test seeds a diverged streams.version vs MAX(events.sequence) fixture and asserts reconciliation or fail-loud behavior, never silent continuation

**Dependencies:** None

### EFF-002 — Emit a blocking projection-degraded signal on stream/event/projection sequence disagreement

**Priority:** P0 · **Program:** PROGRAM-01 · **Risk:** high · **Scope:** medium

**Problem:** CB-8 shows workflow projections silently lagging and contradicting git/event reality (cancelled workflow still shown at plan-review; 7 of 10 completed tasks reported; projection lag exceeded 500s) with no sufficiently prominent degraded-state signal. This is classified open in effects.json and partial in v3-lowering (M027).

**Impact:** Consumers (orchestrate.describe, pipeline/workflow-state views, delegation readiness) can read and act on stale or contradictory state with no fail-safe, propagating CB-1-class corruption into operator-visible decisions.

**Proposed change:** Introduce a comparison chokepoint that computes stream version, event max sequence, and each projection last-applied sequence, and emits a blocking projection_degraded state whenever they disagree; wire every read-surface (views, describe, pipeline) to fail-safe (typed degraded response) instead of silently serving the stale fold.

**Evidence**
- 2026-07-21-phase-gate-v212-dogfood.md:324-335 (CB-8)
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/effects.json#rows[projection.workflow-folds] (disposition: open)
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/v3-lowering.json#rows[M027] (disposition: partial)

**Target files**
- `servers/exarchos-mcp/src/views/workflow-state-projection.ts`
- `servers/exarchos-mcp/src/views/gate-reliability-view.ts`
- `servers/exarchos-mcp/src/projections/rebuild.ts`
- `servers/exarchos-mcp/src/projections/cursor.ts`

**Acceptance proof**
- Fault-injection test seeds a lagging projection cursor behind the event max sequence and asserts every consuming view returns a typed degraded state, not stale data
- No test path shows a view serving data while sequence disagreement exists

**Dependencies:** `EFF-001`

### WFQ-002 — Scope prepare_delegation/worktree readiness to the current waves task list, not all historical task.assigned events

**Priority:** P0 · **Program:** PROGRAM-02 · **Risk:** medium · **Scope:** medium

**Problem:** Delegation readiness derives expected worktrees from the cumulative count of every historical task.assigned event for the workflow (assignedTaskIds.length in handleTaskAssigned), not from the tasks[] argument passed to the current prepare_delegation call. A 4-task wave was rejected because workflow state held 17 total tasks, and after all 17 assignments were emitted, readiness then waited for all 17 worktrees.

**Impact:** Makes incremental/wave-scoped delegation unusable in practice, forcing all-or-nothing dispatch and defeating the purpose of wave decomposition. This is a confirmed regression of previously-closed issue #1206. PRODUCT CODE BUG.

**Proposed change:** Thread the canonicalized task-ID set supplied to the active prepare_delegation call through to the readiness computation so expected and ready are computed only over that set (filter assignedTaskIds/readyTaskIds by the active wave, or track a per-wave readiness sub-state instead of one workflow-wide counter). Historical assignments outside the active wave must not affect readiness for that call.

**Evidence**
- 2026-07-21-phase-gate-v212-dogfood.md:209-231 (CB-2)
- servers/exarchos-mcp/src/views/delegation-readiness-view.ts handleTaskAssigned/handleWorktreeCreated confirmed at candidate SHA: readiness counters (expected, ready) are accumulated from the full historical assignedTaskIds/readyTaskIds arrays with no wave-scoped filter parameter

**Target files**
- `servers/exarchos-mcp/src/views/delegation-readiness-view.ts`
- `servers/exarchos-mcp/src/verbs/team/prepare-delegation.ts`

**Acceptance proof**
- A regression test replays 17 historical task.assigned events then calls prepare_delegation with a 4-task wave and asserts readiness is computed over exactly those 4 tasks
- A test asserts a wave of N tasks reaches ready:true after only N worktree.created events, independent of total historical assignment count
- Reopen/close-with-evidence for #1206 referencing the new wave-scoped test

**Dependencies:** None

### WFQ-003 — Stop parsing full npm/vitest stdout as one JSON document in check_integration_suite

**Priority:** P0 · **Program:** PROGRAM-02 · **Risk:** medium · **Scope:** small

**Problem:** check_integration_suite invokes the suite through npm, whose preamble and workspace banner output are concatenated with the vitest JSON reporter output, so JSON.parse(raw) throws and the gate fails closed with parseError even when the underlying vitest run was green.

**Impact:** The task-completion runbooks final blocking gate (CB-5) fails on unrelated output framing rather than actual test results, for every task, adding a spurious full-suite failure signal on top of already-expensive per-task verification. Matches currently-open issue #1537. PRODUCT CODE BUG.

**Proposed change:** Invoke the resolved Vitest binary directly (bypassing npms own stdout banner) or configure a dedicated JSON reporter output file and read that file instead of stdout. Keep the existing parseError/parseFailureKind (spawn-failure vs shape-mismatch) distinction, but only apply shape-mismatch fail-closed after confirming the output source is actually vitests reporter stream.

**Evidence**
- 2026-07-21-phase-gate-v212-dogfood.md:260-276 (CB-4)
- servers/exarchos-mcp/src/verbs/pure/integration-suite.ts confirmed at candidate SHA: json = JSON.parse(raw) wrapped in try/catch that returns parseError:true on any failure, with no framed-report or direct-binary fallback

**Target files**
- `servers/exarchos-mcp/src/verbs/gates/check-integration-suite.ts`
- `servers/exarchos-mcp/src/verbs/pure/integration-suite.ts`

**Acceptance proof**
- A test runs the gate against a real npm-wrapped vitest invocation with non-JSON preamble output and asserts parseError:false with correct pass/fail/failCount
- Existing #1537 reproduction command no longer produces runner produced no parseable vitest JSON for a green suite

**Dependencies:** None

### WFQ-004 — Reorder task-completion runbook so task_complete never precedes its own blocking gate, and remove duplicate verification ownership

**Priority:** P0 · **Program:** PROGRAM-02 · **Risk:** medium · **Scope:** medium

**Problem:** The task-completion runbook records task_complete at step 5 and only runs check_integration_suite at step 6, so a task can be marked complete before the last blocking step fails. The action description for check_integration_suite explicitly says not to use it for a single tasks scoped tests, yet the runbook runs it per task. Combined with agents self-testing and the lead re-running the same gate chain, the same claims are verified 2-3 times per task with no declared single owner.

**Impact:** Task completion state can misrepresent verification outcome (complete recorded, then blocking gate fails); per-task full-suite runs multiply wall-clock cost across 17 tasks; verification ownership ambiguity is a direct dogfood-cited contributor to the run being slower than comparable harnesses. PRODUCT CODE BUG (ordering) + PROCESS/SKILL DESIGN GAP (ownership).

**Proposed change:** Move check_integration_suite out of the per-task loop and run it once per wave boundary after all wave merges (post_delegation_check or merge-pending phase), consistent with its own action description as a cumulative post-merge backstop. Reorder any remaining per-task steps so task_complete is emitted only after all blocking gates for that task have passed. Update agent/implementer prompts and the runbook description to name exactly one owner per verification claim (agent evidence consumed by the lead; lead performs only independent spot checks plus the wave-level gate).

**Evidence**
- 2026-07-21-phase-gate-v212-dogfood.md:277-293 (CB-5), :414-423 (DOC-6)
- servers/exarchos-mcp/src/runbooks/definitions.ts:3-58 confirmed at candidate SHA: TASK_COMPLETION.steps lists task_complete before check_integration_suite

**Target files**
- `servers/exarchos-mcp/src/runbooks/definitions.ts`
- `skills-src/delegate/SKILL.md`

**Acceptance proof**
- A runbook-shape test asserts task_complete is after every blocking per-task gate and no blocking per-task gate can occur later.
- The cumulative integration suite is absent from the per-task step list and executes exactly once at the wave boundary.
- A verification-ownership contract names one owner per claim and implementer/lead guidance matches it.

**Dependencies:** `WFQ-003`

## P1 implementation backlog

### API-001 — Establish the versioned Exarchos API contract meta-model and authority

**Priority:** P1 · **Program:** PROGRAM-03 · **Risk:** high · **Scope:** large

**Problem:** The MCP protocol schema describes wire tools but cannot represent the complete Exarchos product API: stable action identity, envelopes/errors, execution/evidence policies, presentation, compatibility, host-local commands, extensions, and implementation bindings remain spread across registry and adapters.

**Impact:** Codegen from MCP schemas alone would reproduce current omissions and create another partial authority rather than eliminate contract drift.

**Proposed change:** Approve an Exarchos-owned TypeSpec meta-model that composes MCP protocol semantics and Strategos.Contracts shared IR while owning product-specific action, envelope, policy, presentation, extension, compatibility, host-command contracts, and a disjoint API-action/API-alias/host-command partition.

**Evidence**
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/api-contract-codegen.json
- servers/exarchos-mcp/src/registry.ts:ToolAction
- GitHub #1606 and #1258

**Target files**
- `contracts/exarchos-api/main.tsp`
- `contracts/exarchos-api/tools.tsp`
- `contracts/exarchos-api/envelope.tsp`
- `contracts/exarchos-api/errors.tsp`
- `contracts/exarchos-api/policies.tsp`
- `contracts/exarchos-api/presentation.tsp`
- `contracts/exarchos-api/extensions.tsp`
- `contracts/exarchos-api/compatibility.tsp`
- `contracts/implementation-bindings.ts`

**Acceptance proof**
- Every CLI-visible ID is classified exactly once as API action, API presentation alias, or host command.
- All current API actions, aliases, and host commands round-trip into the meta-model without untyped loss or overlapping classifications.
- Authority precedence between MCP, Strategos.Contracts, Exarchos API, and runtime bindings is documented and tested.
- No executable function is serialized into TypeSpec/JSON Schema; hooks are referenced by stable IDs.

**Dependencies:** `CTR-012`

### API-002 — Migrate the MCP adapter to the 2026-07-28 stateless contract

**Priority:** P1 · **Program:** PROGRAM-03 · **Risk:** high · **Scope:** large

**Problem:** Presentation codegen depends on full JSON Schema 2020-12 output schemas and the stateless request model, while the current adapter still reflects the prior session-oriented specification.

**Impact:** Generating clients before #1604 lands would target obsolete initialization, Tasks, cancellation, error, discovery, and schema semantics.

**Proposed change:** Adopt stateless per-request authenticated context with untrusted _meta hints, request-scoped roots/reverse-request routing, server/discover, full schemas/cache behavior, a shared durable replay/idempotency claim ledger, durable cross-instance task identity/ownership/expiry/tombstones/resumption, worker leases/fencing, idempotent cancellation, and new protocol/error semantics.

**Evidence**
- GitHub #1604
- docs/research/2026-06-21-harness-agnosticism-strategy.md:86-92
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/api-contract-codegen.json:pipeline[1]

**Target files**
- `servers/exarchos-mcp/src/adapters/mcp.ts`
- `servers/exarchos-mcp/src/index.ts`
- `servers/exarchos-mcp/src/dispatch/core/dispatch.ts`
- `servers/exarchos-mcp/src/task-store/`
- `servers/exarchos-mcp/src/registry.ts`

**Acceptance proof**
- Tier-1 protocol conformance passes against the final 2026-07-28 SDK/spec.
- Alternating two clients across fresh server instances proves no principal/capability/root/session leakage.
- A task created on one instance can be polled, cancelled, resumed, and recovered after restart on another instance with owner/scope enforcement.
- Expiry, tombstone, repeated cancellation, reverse-request routing, and load-balancer fixtures pass.
- The same mutation replayed across instances/restart is atomically claimed once, and a stale fenced worker cannot commit effects/results after cancellation.
- The same stable claim retried across API/action/policy upgrades cannot execute a duplicate effect; it returns a stored result, typed conflict, or explicit migration.
- Reusing an idempotency key with a different subject conflicts, revoked current scope blocks stored-result disclosure, and incompatible negotiated result versions require conflict/migration rather than invalid replay.

**Dependencies:** `EFF-001`, `external authority: MCP 2026-07-28 final/SDK`

### API-003 — Build the Exarchos API contract compiler and generated runtime descriptors

**Priority:** P1 · **Program:** PROGRAM-03 · **Risk:** high · **Scope:** large

**Problem:** Zod schemas, TypeScript types, registry descriptors, compatibility metadata, and contract digests are currently authored or merged manually.

**Impact:** A declarative contract that does not generate runtime validators and descriptors cannot become the actual source of truth.

**Proposed change:** Compile Exarchos TypeSpec plus Strategos.Contracts schemas into JSON Schema 2020-12, TypeScript, Zod, serializable descriptors, error/compatibility registries, fixtures, and contract digests.

**Evidence**
- servers/exarchos-mcp/src/registry.ts:ToolAction and CompositeTool
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/api-contract-codegen.json:generatedOutputs

**Target files**
- `contracts/exarchos-api/`
- `scripts/generate-api-contract.ts`
- `servers/exarchos-mcp/src/generated/api-contract/`
- `package.json`

**Acceptance proof**
- Codegen is deterministic and produces zero git drift.
- 119/119 current actions round-trip with total input/success/error/output envelope schemas.
- Every generated path has a generated/do-not-edit marker and manifest entry tied to source model IDs, compiler version, and contract digest.
- CI fails on hand edits, unmanifested generated files, stale source digests, and generator changes without regenerated output in the same commit.

**Dependencies:** `API-001`, `API-002`, `API-006`

### API-004 — Generate MCP registration, discovery, and implementation-binding checks

**Priority:** P1 · **Program:** PROGRAM-03 · **Risk:** high · **Scope:** large

**Problem:** The registry mixes serializable contract data with runtime functions and hand-maintained tool/action descriptions.

**Impact:** Contract generation cannot safely own runtime registration until declarative descriptors and executable bindings are separated and exhaustively reconciled.

**Proposed change:** Generate TOOL_REGISTRY-compatible serializable descriptors, tools/list schemas, server/discover metadata, and contract digests; retain a minimal ActionId-to-handler/summarizer/presenter binding map with build-time orphan/duplicate checks.

**Evidence**
- servers/exarchos-mcp/src/registry.ts
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/api-contract-codegen.json:implementation-bindings

**Target files**
- `servers/exarchos-mcp/src/registry.ts`
- `contracts/implementation-bindings.ts`
- `servers/exarchos-mcp/src/generated/api-contract/`
- `servers/exarchos-mcp/src/adapters/mcp.ts`

**Acceptance proof**
- 119/119 actions have one generated descriptor and one exact implementation binding.
- Adding an action without a binding or a binding without a contract fails the build.
- server/discover returns protocol/API versions, capabilities, and contract digest.

**Dependencies:** `API-002`, `API-003`, `API-010`

### API-005 — Generate the CLI as an in-process MCP-contract client

**Priority:** P1 · **Program:** PROGRAM-03 · **Risk:** high · **Scope:** large

**Problem:** The CLI currently generates some flags but directly calls dispatch and hand-codes rendering, special commands, validation, and exit behavior across a large adapter.

**Impact:** INV-2 equivalence remains test-mediated and every handwritten special path can diverge from MCP validation, errors, authorization, output, and compatibility.

**Proposed change:** Generate argv/flags/coercion/help/result decoding from the API contract. Route API commands through the in-process MCP request handler. Keep only typed presentation policy templates for human rendering, redaction, exit codes, dry-run, and follow/wait UX.

**Evidence**
- GitHub #1606
- servers/exarchos-mcp/src/adapters/cli.ts
- docs/research/2026-06-21-harness-agnosticism-strategy.md:130-146

**Target files**
- `servers/exarchos-mcp/src/adapters/cli.ts`
- `servers/exarchos-mcp/src/adapters/schema-to-flags.ts`
- `servers/exarchos-mcp/src/generated/cli/`
- `contracts/exarchos-api/presentation.tsp`

**Acceptance proof**
- No API action path in the CLI calls dispatch directly.
- Packaged instrumentation proves authorization, capability resolution, input validation, economy, handler binding, output validation, and error mapping execute exactly once.
- Independent hand-authored protocol fixtures and mutation/negative bypass tests validate generated argv and rendering.
- A machine-reconciled matrix covers all 119 API actions and 8 presentation aliases; missing positive/schema/auth/error/bypass/applicable-output/effect cases fail CI.
- Every effectful ActionId passes claim-before-effect, all claim/effect/result crash windows, lease loss, cancellation, takeover, reconciliation/provider-token, and compensation-failure cases.
- Packaged MCP/CLI differential tests prove identical structured envelopes while permitting policy-driven human formatting.

**Dependencies:** `API-003`, `API-004`, `API-006`, `API-010`

### API-006 — Define closed envelope, error, security-policy, and compatibility contracts before compiler wiring

**Priority:** P1 · **Program:** PROGRAM-03 · **Risk:** high · **Scope:** large

**Problem:** Errors, exit codes, capped/degraded results, valid targets, suggested fixes, and compatibility metadata are not one closed, versioned contract across MCP, CLI, and workflow IR.

**Impact:** Codegen can be mechanically complete yet behaviorally incompatible if errors and alternate output shapes remain open or adapter-specific.

**Proposed change:** Define the declarative total failure-origin mapping plus closed success/error envelope unions, stable error registry, retry/target/fix metadata, CLI exits, version negotiation/ranges, directional upcasts, input/output variance, authorization/effect/safety/idempotency/dry-run/task/evidence change classes, canonical digests, deprecation/replacement fields, and mixed-version fixtures. API-003 then generates runtime wiring from this authority.

**Evidence**
- servers/exarchos-mcp/src/contract/schemas/envelope.ts
- servers/exarchos-mcp/src/format.ts
- servers/exarchos-mcp/src/adapters/cli.ts:resolveExitCode
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/api-contract-codegen.json:compatibility

**Target files**
- `contracts/exarchos-api/envelope.tsp`
- `contracts/exarchos-api/errors.tsp`
- `contracts/exarchos-api/compatibility.tsp`
- `servers/exarchos-mcp/src/contract/schemas/envelope.ts`
- `servers/exarchos-mcp/src/format.ts`

**Acceptance proof**
- Every transport, JSON-RPC, method/action, schema, auth, task/cancel, timeout, handler, output, presenter, and internal failure maps exactly once.
- Every runtime-emittable baseline/capped/degraded/error shape validates against the generated output union.
- Every stable error code has a typed payload, CLI exit code, retry policy, compatibility class, and fixture.
- Authorization, effect, safety, idempotency, dry-run, task/cancellation, evidence, economy, and cache policy changes trigger explicit compatibility classification, versioning, and mixed-version refusal/migration tests.
- Old-client/new-server, new-client/old-server, unsupported-range, upcast/downcast, variance, and digest mismatch tests pass.

**Dependencies:** `API-001`, `API-002`

### API-007 — Bind Workflow Builder IR to stable Exarchos ActionIds

**Priority:** P1 · **Program:** PROGRAM-03 · **Risk:** high · **Scope:** large

**Problem:** The v3 Workflow Builder IR and the public action contract can evolve independently, risking workflow nodes that reference missing, incompatible, or facade-specific actions.

**Impact:** The SDK consolidation endpoint cannot delete closed-form registries if workflow definitions do not compile against the same action/effect/evidence authority used by runtime dispatch.

**Proposed change:** Keep Strategos IR vendor-neutral with a namespaced ActionRef (namespace, contract ID, version range). Generate the Exarchos-owned projection from ActionRef to ActionId plus availability, phase, compatibility, effect, and evidence validation.

**Evidence**
- GitHub #1258
- GitHub #1599 contract-first IR sequencing
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/api-contract-codegen.json:workflow-ir-bindings

**Target files**
- `contracts/exarchos-api/`
- `docs/architecture/exarchos-api-contract.md (new)`
- `servers/exarchos-mcp/src/workflow/`
- `servers/exarchos-mcp/src/generated/api-contract/`

**Acceptance proof**
- Strategos.Contracts contains no Exarchos-specific ActionId type in the shared IR core.
- Built-in workflows compile to vendor-neutral ActionRefs that resolve through the generated Exarchos projection.
- Unknown, deprecated-without-migration, wrong-phase, or incompatible action references fail compile-time validation.
- Exarchos-emitted IR round-trips against Strategos.Contracts JSON Schema.

**Dependencies:** `API-001`, `API-003`, `API-004`, `API-006`, `external authority: #1258/#1247`

### API-008 — Emit standard-conformant skills and instructions with enumerated thin shims

**Priority:** P1 · **Program:** PROGRAM-03 · **Risk:** high · **Scope:** large

**Problem:** The current audit treats six runtime renderings as first-class, while #1601/#1608 reframe INV-4 toward one standard SKILL.md, AGENTS.md, and MCP surface plus residual capability shims.

**Impact:** Extending the current render matrix would increase the drift surface the target architecture intends to delete.

**Proposed change:** Generate standard artifacts with logical ActionRefs and no facade syntax. Maintain a generated shim manifest with harness capability, missing-standard rationale, owner, package/install paths, finite expiry, retirement issue, and non-increasing budget; remove redundant renderers and guards.

**Evidence**
- GitHub #1601 and #1608
- docs/system-design.html §05
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/api-contract-codegen.json:INV-4

**Target files**
- `skills-src/`
- `skills/standard/`
- `src/build-skills.ts`
- `AGENTS.md`
- `CLAUDE.md`
- `runtimes/`

**Acceptance proof**
- Standard SKILL.md/AGENTS.md/MCP artifacts load and behave correctly on every conformant harness.
- Every residual shim has a capability reason, finite expiry, package/load proof, and retirement issue.
- The shim count cannot increase without an approved missing-standard exception.
- Retired shims and drift guards are absent from source, package, install destinations, and caches.

**Dependencies:** `API-001`, `API-003`, `API-007`

### API-009 — Define the custom extension contract and trust boundary

**Priority:** P1 · **Program:** PROGRAM-03 · **Risk:** high · **Scope:** large

**Problem:** Consumer-supplied custom tools are an indeterminate open domain with no versioned handshake for schemas, effects, compatibility, namespaces, or trusted annotations.

**Impact:** Generated clients and workflow IR cannot safely consume or present extension actions without distinguishing untrusted metadata from server-trusted policy.

**Proposed change:** Add a signed extension handshake with publisher/implementation provenance, immutable admitted digest, schemas, effects, auth, compatibility, namespace, quotas, expiry/revocation, server-owned allowlists, runtime revalidation, and a server-resolved per-harness spatial posture requirement for every effect capability.

**Evidence**
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/contracts.json:contract.consumer-custom-tools-boundary
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/api-contract-codegen.json:extensionContract

**Target files**
- `contracts/exarchos-api/extensions.tsp`
- `servers/exarchos-mcp/src/registry.ts`
- `servers/exarchos-mcp/src/capabilities/resolver.ts`
- `servers/exarchos-mcp/src/dispatch/core/dispatch.ts`

**Acceptance proof**
- Valid signed extensions are admitted under an isolated namespace and pinned implementation digest.
- Schema bombs, undeclared effects, digest swaps, namespace capture, forged trust, revoked/expired identities, and quota/sandbox violations fail closed.
- Untrusted extension metadata cannot weaken server authentication, authorization, safety, or effect policies.
- Prevention/detection/advisory/unavailable harness posture tests prove admission refuses or safely downgrades extensions whose requested effects exceed the target harness capability.
- Stale/outage revocation data fails closed; signed offline revocation, epoch rollback, and clock rollback tests pass.

**Dependencies:** `API-001`, `API-004`

### API-010 — Generate an independent implementation, security, effect, and output oracle

**Priority:** P1 · **Program:** PROGRAM-03 · **Risk:** high · **Scope:** large

**Problem:** Contract declarations and generated tests can agree on the same wrong handler protection, effect classification, owner, or output variants.

**Impact:** Codegen completeness can be self-consistent while omitting authorization/effect tests for a misclassified handler, producing false equivalence.

**Proposed change:** Build an AST/call-graph and structural-registry oracle independent of TypeSpec that resolves exact handlers, auth guards/scopes, pure/effectful classification, effect owners, dry-run/idempotency/compensation behavior, and observed output variants; reconcile it against generated contracts before client/registration acceptance.

**Evidence**
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/api-contract-codegen.json:independentImplementationOracle
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/effects.json:occurrenceLedger
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/ship-surface.json

**Target files**
- `scripts/generate-implementation-oracle.ts (new)`
- `servers/exarchos-mcp/src/verbs/gates/check-invariant-conformance.ts`
- `scripts/check-gate-runner-ownership.mjs`
- `scripts/generate-ship-surface-graph.ts (new)`

**Acceptance proof**
- Unknown or conflicting handler/auth/effect/output classifications fail CI.
- Negative fixtures detect effectful-as-pure, missing auth, unowned effect, undeclared output variant, and binding swap defects.
- A pinned legacy-to-generated differential corpus covers every ActionId across defaults/coercion, domain results, errors, and ordered effect/event traces.
- A same-signature handler swap fails the semantic/effect-trace differential even when schemas and generated fixtures remain unchanged.
- The oracle independently enumerates effect owners so every effectful ActionId receives the full crash/fencing/compensation matrix.
- API-004/API-005 acceptance consumes this oracle and cannot use generated declarations as its sole truth source.

**Dependencies:** `API-001`, `API-003`

### ART-001 — Produce and record a reproducible dist/exarchos-mcp.js build digest tied to the pinned source SHA

**Priority:** P1 · **Program:** PROGRAM-05 · **Risk:** medium · **Scope:** medium

**Problem:** The candidate tree contains 0 tracked dist files; scripts/build-binary.ts and the package.json build script specify how the bundle is produced, but no built artifact or its digest was ever generated or committed for comparison against source SHA 13cf9642.

**Impact:** There is no way to prove that any distributed dist/exarchos-mcp.js corresponds to the audited source; a supply-chain or build-tool substitution would be undetectable.

**Proposed change:** Run npm run build against the pinned candidate in CI, compute a SHA-256 of the resulting dist/exarchos-mcp.js, and publish it in a checked build-manifest.json keyed by source commit SHA; add a reproducibility check that rebuilds twice and diffs the digest.

**Evidence**
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/artifacts.json row artifact.bundle-spec (disposition indeterminate, tracked dist files: 0 at both SHAs)
- scripts/build-binary.ts, package.json build script

**Target files**
- `scripts/build-binary.ts`
- `package.json`
- `docs/audits/build-manifest.json (new)`

**Acceptance proof**
- CI job artifact: build-manifest.json containing sourceSha, distSha256, builtAt
- Two consecutive npm run build invocations from the same commit produce byte-identical dist output (diff exit 0)

**Dependencies:** None

### ART-002 — Build and hash all five release binary targets for the pinned candidate and record digests in-repo

**Priority:** P1 · **Program:** PROGRAM-05 · **Risk:** medium · **Scope:** large

**Problem:** scripts/build-binary-targets.ts specifies 5 targets (linux-x64, linux-arm64, darwin-x64, darwin-arm64, windows-x64) and release.yml generates SHA-512 sidecars, but no candidate binary was ever built or hashed by any available proof; artifact.binary-release-spec is indeterminate.

**Impact:** Release-time binary identity is entirely unverified pre-publication; a compromised or mismatched cross-compile target could ship without detection until after a public release.

**Proposed change:** Add a pre-release dry-run CI job that builds all 5 targets from the pinned commit, generates SHA-512 sidecars locally (not just at tag-push time), and stores them as a downloadable CI artifact plus a committed docs/audits/release-digests snapshot for auditability.

**Evidence**
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/artifacts.json row artifact.binary-release-spec (disposition indeterminate)
- scripts/build-binary-targets.ts lines 33-37 (5 BINARY_TARGETS)
- .github/workflows/release.yml lines 181-212 (per-target build + sha512sum)

**Target files**
- `scripts/build-binary-targets.ts`
- `.github/workflows/release.yml`
- `docs/audits/release-digests/ (new)`

**Acceptance proof**
- 5 binaries + 5 .sha512 sidecar files produced for commit 13cf9642, recorded with byte counts and SHA-512 values in docs/audits/release-digests

**Dependencies:** `ART-001`

### ART-003 — Embed build/source SHA in the compiled binary version output and bootstrap installer verification

**Priority:** P1 · **Program:** PROGRAM-05 · **Risk:** medium · **Scope:** medium

**Problem:** The installed binary at .exarchos/bin/exarchos.exe reports version 2.12.0-preview.3 and SHA-256 9CFB9D24C73F4EAD5015A628A46A7676E0F30C58C796C9E0DFC93027484ECD66, but exposes no source/build commit SHA, so it cannot be tied to candidate 13cf9642 or any release manifest.

**Impact:** Users and auditors cannot verify that an installed binary was built from a specific, reviewed commit; version string alone is insufficient for provenance or incident response.

**Proposed change:** Inject the git commit SHA as a compiled define (via scripts/build-binary.ts) into the CLI version command output (exarchos --version), and update scripts/get-exarchos.sh / scripts/get-exarchos.ps1 to print and optionally verify the embedded SHA against the GitHub release tag commit.

**Evidence**
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/artifacts.json row artifact.installed-binary (disposition indeterminate, sourceIdentity unknown release/source SHA; semantic version only)
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/artifacts.json row artifact.bootstrap-installers (disposition partial)

**Target files**
- `scripts/build-binary.ts`
- `servers/exarchos-mcp/src/adapters/cli.ts`
- `scripts/get-exarchos.sh`
- `scripts/get-exarchos.ps1`

**Acceptance proof**
- exarchos --version output includes both semantic version and 40-char source commit SHA
- Installed binary metadata (path, bytes, SHA-256) is cross-referenced to the embedded source SHA and matches ART-002 release-digests output

**Dependencies:** `ART-002`

### ART-004 — Close the compiled-binary/process packaged-proof gap for 115 of 119 MCP built-in actions

**Priority:** P1 · **Program:** PROGRAM-05 · **Risk:** high · **Scope:** large

**Problem:** Only workflow.init, workflow.get, workflow.rehydrate, and event.query have an exact process-test invocation; the remaining 115 registered actions (all 77 exarchos_orchestrate actions, all 26 exarchos_view actions, sync.now, event.append/batch_append/describe, and the 8 other workflow actions) have registry contracts and handlers but no compiled-binary/process proof.

**Impact:** The overwhelming majority of the shipped MCP action surface is validated only by source-level unit tests, which this audit explicitly excludes as packaged proof; regressions in the packaged/compiled path would not be caught before release.

**Proposed change:** Expand servers/exarchos-mcp/test/process/ and test/process/ to invoke the compiled binary/composited dispatch for each remaining action family (starting with the 77 orchestrate.* actions), asserting exact output/exit contracts, prioritizing highest-traffic actions (doctor, onboard, review_diff, task_claim/complete/fail) first.

**Evidence**
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/ship-surface.json SHIP-F001 (115 of 119 built-in actions listed by name)
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/ship-surface.json reconciliation.missingPackagedProofCount=115, missingPackagedProof (full action id list)

**Target files**
- `servers/exarchos-mcp/test/process/compiled-binary-mcp.test.ts`
- `test/process/parity-workflow-describe.test.ts`
- `test/process/parity-workflow-rehydrate.test.ts`
- `test/process/parity-event-query.test.ts`
- `test/process/ (new per-action-family suites)`

**Acceptance proof**
- ship-surface reconciliation.missingPackagedProofCount equals 0 for all 119 built-in actions.
- Every built-in action ID has an exact compiled-binary/process proof citation that asserts its output or failure contract.
- Staged delivery may prioritize action families, but ART-004 remains open until the final missing count is zero.

**Dependencies:** `ART-014`

### ART-005 — Add compiled-binary/process proof for the 10 unproven standalone CLI commands

**Priority:** P1 · **Program:** PROGRAM-05 · **Risk:** medium · **Scope:** medium

**Problem:** Of 11 standalone CLI commands, only cli.mcp has an exact compiled-binary/process proof; cli.doctor, cli.emissions, cli.feedback, cli.init, cli.install-skills, cli.merge-orchestrate, cli.onboard, cli.schema, cli.topology, and cli.version are unproven at the packaged level.

**Impact:** CLI entry points reachable directly by end users (doctor, onboard, install-skills, version) can silently break in the packaged binary despite passing source-level tests.

**Proposed change:** Add one process test per standalone command in servers/exarchos-mcp/test/process/ that spawns the compiled CLI binary/entry and asserts exact stdout/exit-code contracts, modeled on the existing compiled-binary-mcp.test.ts pattern.

**Evidence**
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/ship-surface.json SHIP-F004 (10 of 11 standalone CLI commands listed)
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/ship-surface.json reconciliation.packagedProofStandaloneCli=[cli.mcp], missingStandaloneCliProofCount=10

**Target files**
- `servers/exarchos-mcp/test/process/compiled-binary-mcp.test.ts`
- `servers/exarchos-mcp/src/adapters/cli.ts`

**Acceptance proof**
- reconciliation.packagedProofStandaloneCli includes all 11 cli.* command ids with cited test file references
- missingStandaloneCliProofCount = 0

**Dependencies:** `ART-014`

### ART-006 — Diagnose and remediate the installed Copilot skill cache mismatch (0/3 byte matches)

**Priority:** P1 · **Program:** PROGRAM-05 · **Risk:** medium · **Scope:** medium

**Problem:** The accessible installed skill cache at .agents/skills (55 entries) disagrees byte-for-byte with all 3 overlapping candidate Copilot skill entries (delegate, ideate, refactor), and carries no version/source metadata to distinguish staleness from intentional local override.

**Impact:** A user runtime may be executing stale or diverged skill instructions without any signal, undermining the guarantee that skills:guard-verified repository content is what actually runs.

**Proposed change:** Add a source/version header (frontmatter field with source package version + content hash) to generated SKILL.md files, and ship a doctor/cache-verify subcommand that compares installed skill hashes against the currently installed package version shipped hashes, reporting exact match, stale, or locally-modified.

**Evidence**
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/artifacts.json row artifact.installed-skill-cache (disposition open; overlap: delegate, ideate, refactor; byte matches: 0; mismatches: 3)

**Target files**
- `skills-src/delegate/SKILL.md`
- `skills-src/ideate/SKILL.md`
- `skills-src/refactor/SKILL.md`
- `servers/exarchos-mcp/src/cli-commands/install-skills-bridge.js`
- `servers/exarchos-mcp/src/verbs/onboard/install.ts`

**Acceptance proof**
- exarchos doctor (or equivalent) reports per-skill installed-vs-shipped hash comparison with explicit stale/match/modified verdicts
- Re-running the installed-cache probe shows 3/3 byte matches after reinstall, or an explicit locally modified verdict instead of silent mismatch

**Dependencies:** None

### ART-007 — Establish an install fixture proving the plugin cache location and version identity

**Priority:** P1 · **Program:** PROGRAM-05 · **Risk:** low · **Scope:** small

**Problem:** No plugin cache was found at the known probed path (.claude/plugins/cache/lvlup-sw/exarchos), leaving plugin freshness indeterminate rather than provably fresh or provably absent.

**Impact:** Without a documented cache location and identity marker, plugin packaging correctness (artifact.plugin-manifest disposition partial) cannot be closed, and future installs cannot be diffed against the candidate manifest.

**Proposed change:** Document the authoritative plugin cache path(s) per platform/client, and add an install fixture/integration test that installs the plugin from the candidate manifest and asserts the resulting cache directory version/content against .claude-plugin/plugin.json.

**Evidence**
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/artifacts.json row artifact.plugin-cache (disposition indeterminate)
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/artifacts.json row artifact.plugin-manifest (disposition partial; no accessible installed plugin cache was found at the probed path)

**Target files**
- `.claude-plugin/plugin.json`
- `scripts/validate-plugin.sh`
- `docs/ (plugin cache location documentation)`

**Acceptance proof**
- Install fixture output recording cache path, byte count, and version match against .claude-plugin/plugin.json for the pinned candidate

**Dependencies:** None

### ART-008 — Add packaged-containment proof for every SHIP-F003 surface

**Priority:** P1 · **Program:** PROGRAM-05 · **Risk:** medium · **Scope:** large

**Problem:** SHIP-F003 currently lists 130 generated, packaged-source, and compiled-contract surfaces with missing package/install or aggregate bundle proof.

**Impact:** Repository-side generation guards (skills:guard, hooks:guard, runtimes:guard) prove internal consistency but not that the shipped package/plugin/install actually contains and loads the guarded output.

**Proposed change:** Build class-specific package/install/composition fixtures: exact installed hashes for generated and packaged-source artifacts, loader assertions for plugin skills/commands/agents/hooks/aliases/runtimes, and a deterministic build composition manifest for compiled workflow/config/runbook sources.

**Evidence**
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/ship-surface.json SHIP-F003 (evidence list of ship.generated-agent, ship.hook-projection, ship.runtime-alias, ship.command-entry, ship.generated-skill ids)

**Target files**
- `servers/exarchos-mcp/test/process/`
- `test/e2e/fresh-install-bootstrap.test.ts`
- `src/packaging-consistency.test.ts`
- `scripts/validate-installation.sh`
- `scripts/generate-ship-surface-graph.ts`

**Acceptance proof**
- Every current SHIP-F003 evidence row has a concrete packagedProof citation and no packaged-containment or compiled-bundle missing edge.
- SHIP-F003 is removed or has an empty evidence set after ship-surface regeneration.
- Negative fixtures omit one surface from each delivery class and fail the corresponding package/install/composition check.

**Dependencies:** None

### ART-011 — Publish a signed, source-SHA-linked release manifest consumed by bootstrap installers

**Priority:** P1 · **Program:** PROGRAM-05 · **Risk:** medium · **Scope:** medium

**Problem:** scripts/get-exarchos.sh and scripts/get-exarchos.ps1 validate SHA-512 checksums at install time, but no release manifest ties the release checksums back to the exact source commit SHA that was reviewed/pinned, so installer trust stops at checksum matches the file GitHub served.

**Impact:** A compromised release job or manual asset re-upload could still pass checksum validation while not corresponding to any reviewed commit.

**Proposed change:** Publish a source-SHA-linked release manifest plus an independently verifiable provenance attestation/signature (for example Sigstore/cosign keyless OIDC or GitHub artifact attestation). Pin the expected issuer/repository/ref trust policy in both bootstrap installers and reject unsigned or policy-mismatched manifests before asset checksum verification.

**Evidence**
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/artifacts.json row artifact.bootstrap-installers (disposition partial; checksum provenance not available)
- .github/workflows/release.yml lines 181-317 (checksum generation, no source-SHA binding recorded)

**Target files**
- `.github/workflows/release.yml`
- `scripts/get-exarchos.sh`
- `scripts/get-exarchos.ps1`

**Acceptance proof**
- Release assets include the manifest and independently verifiable signature/attestation bound to the tagged source commit and all asset digests.
- Both installers reject a forged manifest/checksum set, wrong repository/issuer, wrong source SHA, missing signature, and tampered asset.
- A release fixture verifies the trusted path succeeds without embedding a long-lived private signing key.

**Dependencies:** `ART-002`, `ART-003`

### ART-014 — Add a CI coverage-ratchet gate for compiled-binary/process packaged-proof ratio

**Priority:** P1 · **Program:** PROGRAM-05 · **Risk:** low · **Scope:** medium

**Problem:** The current packaged-proof ratio (4/119 actions, 1/11 CLI commands) has no automated floor; without a ratchet, future additions to the 119-action registry could further dilute proof coverage without any CI signal, and existing gains from ART-004/ART-005 could regress silently.

**Impact:** Packaged-proof coverage is a manually-audited metric today; absent a ratchet it cannot be trusted to hold or improve over time.

**Proposed change:** Add a script (modeled on scripts/check-coverage-ratchet.mjs) that extracts registered actions/CLI commands and cross-references them against process-test assertions in servers/exarchos-mcp/test/process/ and test/process/, failing CI if the proven-action count decreases versus the last recorded ratchet baseline.

**Evidence**
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/ship-surface.json reconciliation.missingPackagedProofCount=115, missingStandaloneCliProofCount=10
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/ship-surface.json declaredScope.excluded: source-only unit tests as packaged proof

**Target files**
- `scripts/check-coverage-ratchet.mjs`
- `scripts/check-packaged-proof-ratchet.mjs (new)`
- `package.json`

**Acceptance proof**
- New script reports proven/total counts for both MCP actions and standalone CLI commands and fails CI on regression below the recorded baseline
- Baseline recorded as 4/119 actions and 1/11 CLI commands at commit 13cf9642, with subsequent PRs required to meet or exceed it

**Dependencies:** None

### BASE-005 — Make post-append hook and channel delivery semantics explicit and observable

**Priority:** P1 · **Program:** PROGRAM-04 · **Risk:** medium · **Scope:** medium

**Problem:** event.append and batch_append invoke hookRunner and channelEmitter after the authoritative append, but both secondary effects swallow errors without retry, durable failure facts, or caller-visible diagnostics.

**Impact:** Required notifications can be silently lost while the event caller receives success, and the ship-surface graph previously omitted both effects entirely.

**Proposed change:** Declare each secondary delivery as either best-effort telemetry with loss metrics or required delivery backed by a durable outbox/retry owner. Emit structured failure/lag evidence without rolling back the authoritative event append.

**Evidence**
- servers/exarchos-mcp/src/event-store/composite.ts:19-67
- servers/exarchos-mcp/src/event-store/composite.ts:107-155
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/effects.json:event.hook-dispatch
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/effects.json:event.channel-push

**Target files**
- `servers/exarchos-mcp/src/event-store/composite.ts`
- `servers/exarchos-mcp/src/channel/`
- `servers/exarchos-mcp/src/dispatch/core/dispatch.ts`

**Acceptance proof**
- Failure-injection tests prove hook/channel errors never corrupt the authoritative append and are never silent.
- Required-delivery mode persists retry/outbox state and proves eventual delivery; best-effort mode emits observable loss metrics.
- Ship-surface rows for event.append and event.batch_append link both secondary effect owners.

**Dependencies:** `EFF-001`

### CTR-011 — Establish generated-agent/documentation-authority single-source lowering for agent-principles.md and invariants.md family

**Priority:** P1 · **Program:** PROGRAM-03 · **Risk:** medium · **Scope:** medium

**Problem:** Documentation authorities (.exarchos/invariants.md, agent-principles.md, docs/architecture/invariants-v3-contract-seam.md, docs/system-design.html) and generated agents (agents/fixer.md, implementer.md, reviewer.md, scaffolder.md) are checked for byte-reproduction from canonical sources per-document, but there is no single authority binding invariants content, agent capability descriptions, and the action-contract IDL together (contracts.json documentation-authority rows all disposition partial).

**Impact:** Invariant/principle text can diverge from the actual enforced action/effect surface it documents, since the only guard is document-specific structural tests where present; otherwise review rather than a generation binding to the action contract.

**Proposed change:** Add a structural test (extending servers/exarchos-mcp/src/architecture/vocabulary-lint-cli.ts) that cross-checks every action/effect/gate class named in invariants.md and agent-principles.md against the action-contract IDL (CTR-001) and generated agent files, failing when a documented invariant references a removed or renamed action/effect.

**Evidence**
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/contracts.json:documentation-authority..exarchos:invariants.md
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/contracts.json:documentation-authority.agent-principles.md
- 13cf9642:.exarchos/invariants.md
- 13cf9642:agent-principles.md

**Target files**
- `.exarchos/invariants.md`
- `agent-principles.md`
- `servers/exarchos-mcp/src/architecture/vocabulary-lint-cli.ts`
- `servers/exarchos-mcp/src/agents/generate-agents.ts`

**Acceptance proof**
- New lint rule fails CI when invariants.md/agent-principles.md references an action/effect absent from the contract source
- contracts.json documentation-authority rows move from document-specific structural tests where present; otherwise review to a named blocking guard for all 4 rows

**Dependencies:** `API-001`

### CTR-012 — Resolve the v3 authority decisions required before generated contract work

**Priority:** P1 · **Program:** PROGRAM-03 · **Risk:** high · **Scope:** medium

**Problem:** Generated contract and guidance work cannot target a stable model while workflow-IR, admission-policy, action projection, runtime chokepoint, and retirement ownership decisions remain unresolved.

**Impact:** Starting CTR-001/CTR-006 before authority decisions are pinned risks generating a second temporary contract system and repeating the consolidation churn the roadmap is intended to avoid.

**Proposed change:** Split the lowering ledger into authority decisions versus downstream implementation. Approve an interim versioned API-contract ADR/freeze for the decisions required by API-001/API-008 before code generation begins; later roadmap/issue changes must produce a compatibility/migration diff against the pin.

**Evidence**
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/v3-lowering.json:LOWERING-F001
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/v3-lowering.json:LOWERING-F003
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/v3-lowering.json:universe

**Target files**
- `docs/system-design.html`
- `.exarchos/invariants.md`
- `docs/architecture/exarchos-api-contract.md (new)`

**Acceptance proof**
- Every contract/guidance mechanism required by API-001 and API-008 has one approved, versioned disposition with no unresolved or competing source.
- The pinned ADR records authority owners, version/digest, supersession rules, and the migration obligation when #1258/#1599 changes.
- API-001 design cites the pin and introduces no temporary parallel registry or workflow-definition format.

**Dependencies:** `external authority: v3 roadmap owner approval`

### EFF-003 — Prove gate-evidence concurrency and supersession under equivalent concurrent operations

**Priority:** P1 · **Program:** PROGRAM-01 · **Risk:** medium · **Scope:** medium

**Problem:** gate-runner.ts awaits artifact/event append and keys idempotency on evidenceId with a sameOperation dedup check (gate-runner.ts:309-323), but the audit finds concurrency/supersession behavior for equivalent concurrent executions with distinct operationIds is unproven; competing active-predecessor evidence chains can result.

**Impact:** Two concurrent equivalent gate executions could each believe they are the active/authoritative evidence chain, risking duplicate success carriers or non-deterministic admission decisions.

**Proposed change:** Add an integration test that races two concurrent gate executions with distinct operationIds but identical (requirementId, phaseAttemptId, provider, subject) and asserts exactly one active evidence chain is selected deterministically with no duplicate success carrier escaping before append.

**Evidence**
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/effects.json#rows[gate.evidence-append] (disposition: partial, bypasses: concurrent distinct operationIds)
- 13cf9642:servers/exarchos-mcp/src/verbs/gates/gate-runner.ts:305-365 (sameOperation / activePredecessor)

**Target files**
- `servers/exarchos-mcp/src/verbs/gates/gate-runner.ts`
- `servers/exarchos-mcp/src/verbs/gate-runner.gate.test.ts`
- `servers/exarchos-mcp/src/event-store/atomic-appender.gate.test.ts`

**Acceptance proof**
- New concurrency test proves single active evidence chain and deterministic supersession for equivalent concurrent executions
- Test asserts no success carrier is observable before the awaited append resolves

**Dependencies:** `EFF-001`

### EFF-004 — Prove rehydrate handoff-summarized fallback precedence under projection degradation

**Priority:** P1 · **Program:** PROGRAM-04 · **Risk:** medium · **Scope:** small

**Problem:** rehydration/reducer.ts applies an auto-summary fallback (workflow.handoff_summarized, #1242) only when no operator-authored handoff currently holds, and serialize.ts enforces DR-18 no-silent-envelope-fallback; neither path has an integration proof combining rehydrate fallback selection with the CB-8 projection-lag scenario (tests/outcome/rehydrate-projection-drift.test.ts exists but its coverage of degraded-projection plus fallback precedence is not established in the audit).

**Impact:** If rehydrate fallback selection runs against a lagging/degraded projection, an operator could receive a summarized handoff that silently supersedes or races an authored one, or rehydrate from a stale fold without signaling degradation.

**Proposed change:** Extend rehydrate-projection-drift.test.ts to assert that when the projection-degraded signal from EFF-002 is active, rehydrate blocks or clearly marks fallback output as degraded rather than presenting a confident summarized handoff, and that an operator-authored handoff always wins the race regardless of projection lag.

**Evidence**
- 13cf9642:servers/exarchos-mcp/src/projections/rehydration/reducer.ts:659,931 (handoff_summarized fallback, operator precedence)
- 13cf9642:servers/exarchos-mcp/src/projections/rehydration/serialize.ts:172 (InvalidEnvelopeError, DR-18)
- 13cf9642:tests/outcome/rehydrate-projection-drift.test.ts
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/effects.json#rows[projection.workflow-folds]

**Target files**
- `servers/exarchos-mcp/src/projections/rehydration/reducer.ts`
- `servers/exarchos-mcp/src/projections/rehydration/reducer.delegate-contract.test.ts`
- `tests/outcome/rehydrate-projection-drift.test.ts`

**Acceptance proof**
- New/extended test proves operator-authored handoff always precedes auto-summary fallback under simulated projection lag
- Rehydrate output under a degraded projection signal is typed as degraded, never silently confident

**Dependencies:** `EFF-002`

### EFF-005 — Define cancellation process-manager replay initialization for pre-existing workflows

**Priority:** P1 · **Program:** PROGRAM-04 · **Risk:** medium · **Scope:** medium

**Problem:** The cancellation process manager (M016) is fully replayable and test-covered for new workflows, but the audit finds no defined strategy for initializing the cancel state machine on replay of workflows created before the mechanism existed: unclear whether such workflows receive synthesized cancel initialization or are simply non-cancellable.

**Impact:** Ambiguous cancel-replay semantics risk either an inconsistent/non-deterministic cancel state on old workflows or an undocumented permanently-non-cancellable class of workflows, both of which are compensation/rollback correctness gaps.

**Proposed change:** Decide and document the replay policy: either synthesize a deterministic cancel-machine initial state for pre-existing workflow streams during replay, or explicitly type such workflows as non-cancellable and enforce that classification at the cancel action entry point.

**Evidence**
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/v3-lowering.json#rows[M016] (disposition: partial)

**Target files**
- `servers/exarchos-mcp/src/orchestrate/`
- `servers/exarchos-mcp/src/projections/workflow-state/reducer.ts`

**Acceptance proof**
- Replay test over a pre-mechanism workflow fixture asserts deterministic cancel-state initialization (or an explicit typed non-cancellable rejection) with no ambiguous or crashing state

**Dependencies:** None

### EFF-006 — Prove content-addressed artifact store containment and concurrency across every packaged entry point

**Priority:** P1 · **Program:** PROGRAM-04 · **Risk:** low · **Scope:** small

**Problem:** The content-addressed store (M004, gate.artifact-cas) performs atomic write/publish and SHA-256 digest verification, but the audit finds runtime path/permission/containment behavior is not proven for every packaged CLI/MCP entry point, and caller-selected state-directory writability is not packaged-runtime proof.

**Impact:** A packaged entry point with an unwritable or misconfigured state directory, or two concurrent publications of the same digest, could fail in an unproven way (partial write, permission error mid-publish, or race on the same content hash).

**Proposed change:** Add packaged-process tests that exercise the CAS from each supported entry point (CLI binary, MCP server) against a contained temp state root, covering concurrent publication of identical and distinct digests, cleanup after write failure, and digest-mismatch-on-read rejection.

**Evidence**
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/effects.json#rows[gate.artifact-cas] (disposition: partial)
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/v3-lowering.json#rows[M004] (disposition: partial)

**Target files**
- `servers/exarchos-mcp/src/artifacts/content-addressed-store.ts`
- `servers/exarchos-mcp/src/utils/atomic-write.ts`

**Acceptance proof**
- Packaged test proves concurrent publication of the same digest converges to one artifact with no partial/corrupt file left behind
- Digest-mismatch-on-read test proves a typed rejection, not silent acceptance

**Dependencies:** None

### EFF-007 — Close the generic event.append authorization and packaged-proof gap

**Priority:** P1 · **Program:** PROGRAM-01 · **Risk:** medium · **Scope:** small

**Problem:** The reserved-proof-event authorization guard (M005) is built-in and fail-closed for admission evidence events, but ship-surface.json lists event.append among 115 of 119 built-in actions lacking located compiled-binary/process packaged proof (SHIP-F001), meaning the generic append surface authorization is not verified end-to-end in a packaged runtime.

**Impact:** A generic, unauthenticated or under-authorized append path could bypass the reserved-event guard in a packaged deployment even though the guard is correct in source, since no packaged test currently proves it is reachable and enforced.

**Proposed change:** Add a packaged-process test (compiled binary or MCP server harness) that calls event.append directly for a reserved event kind and asserts the authorization guard rejects it, then calls it through the canonical gate/decide path and asserts success, closing the packaged-proof gap named in SHIP-F001 for this specific action.

**Evidence**
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/v3-lowering.json#rows[M005] (disposition: partial)
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/ship-surface.json#findings[SHIP-F001] (event.append listed among unproven actions)
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/effects.json#rows[event-store.authoritative-append]#bypasses (generic append surfaces require separate authorization proof)

**Target files**
- `servers/exarchos-mcp/src/event-store/admission-event-authorization.test.ts`
- `servers/exarchos-mcp/test/process/`
- `servers/exarchos-mcp/src/registry.ts`

**Acceptance proof**
- Packaged process test proves reserved-event append is rejected when attempted outside the canonical decide/gate path and accepted through it

**Dependencies:** `EFF-001`

### EFF-008 — Make CLI and MCP configuration writes atomic with corruption recovery

**Priority:** P1 · **Program:** PROGRAM-04 · **Risk:** low · **Scope:** small

**Problem:** src/operations/config.ts and src/operations/mcp.ts perform direct JSON configuration overwrites; errors propagate, but neither path is proven to use atomic replacement or to recover a corrupted/partial write.

**Impact:** A crash or error mid-write can leave a corrupted or half-written configuration file that the next CLI/MCP invocation reads, with no documented recovery path.

**Proposed change:** Route both writers through a shared atomic-write primitive (write to temp file in the same directory, fsync, rename) and add a validation-before-promotion step; add a corruption-recovery test that seeds a truncated/invalid config file and asserts a typed repair or explicit typed failure rather than a crash or silent partial read.

**Evidence**
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/effects.json#rows[cli.config-write] (disposition: partial)
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/effects.json#rows[cli.mcp-config-write] (disposition: partial)

**Target files**
- `src/operations/config.ts`
- `src/operations/mcp.ts`
- `servers/exarchos-mcp/src/utils/atomic-write.ts`

**Acceptance proof**
- Failure-injection test kills the process mid-write and asserts the prior valid configuration or a clean temp-file artifact remains, never a corrupted target file
- Config read path rejects invalid JSON with a typed error, not a silent default

**Dependencies:** None

### EFF-009 — Stage and atomically promote multi-file skill/installer copies with rollback proof

**Priority:** P1 · **Program:** PROGRAM-04 · **Risk:** medium · **Scope:** large

**Problem:** src/operations/copy.ts, src/install-skills.ts, scripts/get-exarchos.sh, and scripts/get-exarchos.ps1 each perform multi-file installation/promotion where a later-file failure can leave a partially updated destination tree; none of these four independently owned effect sites has proven atomic staged promotion or rollback.

**Impact:** A failure partway through a skill copy or installer promotion (disk full, permission denial, interrupted process) can leave an inconsistent half-installed state on the user machine with no automatic repair.

**Proposed change:** Introduce a shared stage-then-promote pattern: write all files to a staging directory, verify completeness, then atomically swap/rename into place (or use a manifest of previous state for rollback); add failure-injection tests for each of the three call sites that kill the process after a partial file set is staged and assert the destination is left in its prior consistent state.

**Evidence**
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/effects.json#rows[cli.copy-and-install-skills] (disposition: partial)
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/effects.json#rows[installer.posix-promote] (disposition: partial)
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/effects.json#rows[installer.powershell-promote] (disposition: partial)

**Target files**
- `src/operations/copy.ts`
- `src/install-skills.ts`
- `scripts/get-exarchos.sh`
- `scripts/get-exarchos.ps1`

**Acceptance proof**
- Failure-injection test per installer proves the destination tree is either fully old or fully new after a mid-promotion failure, never mixed
- A manifest or staging directory allows deterministic repair/retry without manual cleanup

**Dependencies:** None

### EFF-010 — Enforce single-owner git/worktree mutation with an architecture check against direct bypasses

**Priority:** P1 · **Program:** PROGRAM-04 · **Risk:** medium · **Scope:** medium

**Problem:** git-exec-default.ts and worktree/ centralize git execution with dry-run/recovery machinery, but the audit finds repository-wide single-owner closure is not proven: legacy/direct git execution sites outside the manager remain an explicitly bounded search limitation, not a closed census.

**Impact:** A direct git invocation outside the centralized executor would bypass recovery-point recording, dry-run interception, and serialized merge protection, risking untracked worktree corruption during concurrent orchestration.

**Proposed change:** Extend the gate-ownership-census pattern (scripts/check-gate-runner-ownership.mjs) to a git-mutation census that greps for direct child_process git invocations outside git-exec-default.ts and worktree/, and fails CI on any new occurrence; document/retire any found legacy sites.

**Evidence**
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/effects.json#rows[orchestrate.git-worktree-merge] (disposition: partial, bypasses: legacy/direct git execution sites)

**Target files**
- `servers/exarchos-mcp/src/verbs/vcs/git-exec-default.ts`
- `servers/exarchos-mcp/src/verbs/worktree/`
- `scripts/check-gate-runner-ownership.mjs`

**Acceptance proof**
- New or extended census script enumerates every git-mutating call site and fails when a call site outside the centralized executor is introduced
- Existing legacy direct-execution sites (if any) are enumerated with an explicit typed disposition, not left as an open search limitation

**Dependencies:** None

### EFF-011 — Establish a cross-provider VCS idempotency and compensation contract

**Priority:** P1 · **Program:** PROGRAM-04 · **Risk:** medium · **Scope:** large

**Problem:** orchestrate/vcs/ and vcs/ own remote mutations (create/list/check/merge/comment) through provider adapters, but cross-provider remote idempotency and compensation semantics are provider-specific rather than one generated contract; provider parity tests exist but failure/partial-success semantics are not proven equivalent across providers.

**Impact:** A network/API failure after a remote mutation partially succeeds (e.g., PR created but comment failed) can leave provider-specific inconsistent remote state with no guaranteed compensating action, and behavior may differ silently between providers.

**Proposed change:** Define a shared idempotency-key and compensation-action contract in the provider interface (e.g., every mutating action returns a resumable operation ID and a documented compensating action); extend provider parity tests to assert identical partial-failure and idempotent-retry behavior across every registered provider using recorded-response fixtures.

**Evidence**
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/effects.json#rows[orchestrate.vcs-providers] (disposition: partial)

**Target files**
- `servers/exarchos-mcp/src/verbs/vcs/`
- `servers/exarchos-mcp/src/vcs/`

**Acceptance proof**
- Parity test suite replays an identical partial-failure fixture (e.g., create succeeds, comment fails) against every provider and asserts identical typed compensation/retry behavior

**Dependencies:** None

### EFF-012 — Prove idempotent retry and rollback for onboarding install across supported runtimes

**Priority:** P1 · **Program:** PROGRAM-04 · **Risk:** medium · **Scope:** medium

**Problem:** orchestrate/onboard/install.ts owns repository/user installation and configuration, but multi-step onboarding can leave partial files/configuration unless action-level rollback succeeds, and packaged cross-platform rollback/freshness proof is not established.

**Impact:** A failed onboarding run (network interruption, permission error, partial platform-specific write) can leave a user repository in a half-onboarded state with no proven idempotent re-run.

**Proposed change:** Add failure-injection tests per supported runtime that interrupt onboarding after each step and assert re-running onboard is idempotent (converges to the same final state) and that partial state is either rolled back or safely resumable.

**Evidence**
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/effects.json#rows[orchestrate.onboard-install] (disposition: partial)

**Target files**
- `servers/exarchos-mcp/src/verbs/onboard/install.ts`

**Acceptance proof**
- Per-runtime failure-injection test proves idempotent re-run converges to a complete, consistent onboarded state after any single-step interruption

**Dependencies:** None

### EFF-013 — Classify and structurally own every indeterminate effect occurrence

**Priority:** P1 · **Program:** PROGRAM-04 · **Risk:** high · **Scope:** large

**Problem:** The exhaustive static occurrence ledger maps 339 candidate effects, but 131 currently fall through to the dynamic/indeterminate owner boundary rather than a specific owner row or justified exclusion.

**Impact:** Repository-wide effect closure cannot be claimed while nearly half of the static candidates require a fresh ownership decision; hidden mutation paths can bypass dry-run, rollback, or policy.

**Proposed change:** Promote the occurrence ledger into a maintained typed ownership manifest. Classify every candidate by concrete owner, build/test exclusion, or explicit external capability; add detectors/negative fixtures and fail CI on new indeterminate candidates.

**Evidence**
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/effects.json: occurrenceLedger.occurrenceCount=339
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/effects.json: occurrenceLedger.reconciliation.indeterminate=131
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/effects.json: effect.dynamic-extension-boundary

**Target files**
- `docs/audits/2026-07-23-structural-closure-delta-audit/effects.json`
- `scripts/check-gate-runner-ownership.mjs`
- `scripts/enforcer-wiring-manifest.json`
- `servers/exarchos-mcp/src/dispatch/core/`

**Acceptance proof**
- The effect occurrence ledger reports indeterminate=0 and unclassified=0.
- A negative fixture adding an unowned filesystem/process/network/event append fails the ownership gate.
- Every external/dynamic effect declares capabilities and failure semantics before dispatch.

**Dependencies:** `EFF-008`

### WFQ-005 — Fix check_test_adequacy to reliably discover and revert task-added files on committed branches

**Priority:** P1 · **Program:** PROGRAM-06 · **Risk:** medium · **Scope:** medium

**Problem:** check_test_adequacy (the kill-probe gate) failed with discriminant revert-conflict when a tasks branch added a new source file (it could not revert task-added source to prove the new tests go red), and separately returned no-new-tests for branches that plainly added test files, passing vacuously without probing them.

**Impact:** Initially blocks correct, well-tested tasks; later silently passes tasks without actually running the kill-probe it exists to run. Since #1587 retired check_tdd_compliance, this is now the sole per-task load-bearing verification gate, so its unreliability directly undermines the verification ladders central claim. PRODUCT CODE BUG.

**Proposed change:** Land task-added-source-path handling (detect and correctly revert only pre-existing hunks, not entirely-new files, or handle new-file reversion by deletion+restore). Add an integration test that runs the gate against a committed branch (merge-base..HEAD) rather than only uncommitted worktree hunks. Assert the gate discovers new/modified test files from git diff against merge-base. Treat no-new-tests as a failure (not a vacuous pass) for medium/high-risk tasks when git reports added or modified test files.

**Evidence**
- 2026-07-21-phase-gate-v212-dogfood.md:232-258 (CB-3)
- servers/exarchos-mcp/src/runbooks/definitions.ts confirmed at candidate SHA: check_test_adequacy step note calls it the load-bearing per-task gate and the sole per-task gate after check_tdd_compliance was retired (#1587)

**Target files**
- `servers/exarchos-mcp/src/verbs/gates/test-adequacy.ts`
- `servers/exarchos-mcp/src/verbs/gates/test-adequacy.test.ts`

**Acceptance proof**
- A test commits a branch that adds both a new source file and a new test file, runs the gate, and asserts it reverts only the source change and reports a real red/green kill-probe result (not revert-conflict, not no-new-tests)
- A negative-control test asserts a branch with added test files but no behavior change is NOT silently passed as no-new-tests when risk tier is medium/high

**Dependencies:** None

### WFQ-006 — Parse the canonical unified spec template in check_plan_coverage / spec_coverage_check

**Priority:** P1 · **Program:** PROGRAM-06 · **Risk:** low · **Scope:** small

**Problem:** parseDesignSections only recognizes ### subsections under legacy top-level headings (Technical Design, Design Requirements, Requirements) and returns NO_DESIGN_SECTIONS for specs using the current unified template, which places DR-N and technical design content under Design & Rationale.

**Impact:** Required authors to add an artificial duplicate Technical Design compatibility section purely to satisfy the gate, adding maintenance burden and drift risk between the real content and the compatibility shim. PRODUCT CODE BUG (parser lag behind template change).

**Proposed change:** Add Design & Rationale (and its DR-N subsection convention) to the recognized top-level heading set in parseDesignSections, matching the current unified spec template exactly. Remove the requirement for a duplicate legacy heading once the unified-template path is covered.

**Evidence**
- 2026-07-21-phase-gate-v212-dogfood.md:294-306 (CB-6)
- servers/exarchos-mcp/src/verbs/gates/plan-coverage.ts:59-90,722-731 confirmed at candidate SHA: heading list does not include Design & Rationale; plan-coverage.test.ts:1001 asserts NO_DESIGN_SECTIONS as an expected error code

**Target files**
- `servers/exarchos-mcp/src/verbs/gates/plan-coverage.ts`
- `servers/exarchos-mcp/src/verbs/gates/plan-coverage.test.ts`

**Acceptance proof**
- A test feeds a spec using only Design & Rationale with DR-N subsections and asserts the gate finds design sections (no NO_DESIGN_SECTIONS)
- A repository-wide grep confirms no current spec under docs/specs/ needs an artificial duplicate compatibility heading after the fix

**Dependencies:** None

### WFQ-007 — Add breadth/size estimation signals to check_task_decomposition

**Priority:** P1 · **Program:** PROGRAM-06 · **Risk:** low · **Scope:** medium

**Problem:** check_task_decomposition reported 17/17 tasks well-decomposed against a playbook requirement of 2-5 minutes of focused work per task, while the same plans first ten merged tasks actually produced 41 files and 9585 insertions. The gate checks presence of descriptions, files, tests, DAG shape, and simple overlap, but not task breadth, likely line volume, number of distinct behaviors, or expected execution time.

**Impact:** Gives false confidence at the planning gate that tasks are small and safe to delegate in parallel, when in practice they are large, high-risk, and boundary-touching, which then drives the maximum verification profile (compounding with WFQ-001..005). PRODUCT CODE BUG (gate is under-powered, not merely incomplete).

**Proposed change:** Add warnings/failures for: broad file sets per task beyond a configured threshold; plans where nearly all tasks are stamped high-risk/boundary-touching (tie into WFQ-009s reclassification check); task descriptions implying multiple distinct behaviors; and an estimated size heuristic derived from named behaviors and historical file-change data for similarly-scoped tasks. Require explicit rationale text when a task exceeds the configured size threshold.

**Evidence**
- 2026-07-21-phase-gate-v212-dogfood.md:307-322 (CB-7)

**Target files**
- `servers/exarchos-mcp/src/verbs/check-task-decomposition.ts`
- `servers/exarchos-mcp/src/verbs/tasks/task-decomposition.ts`

**Acceptance proof**
- A test feeds the actual v2.12 17-task plan shape (or an equivalent fixture) and asserts the gate now flags breadth/blanket-risk-stamp warnings instead of reporting 17/17 well-decomposed
- A fixture task with an explicit oversized-task rationale passes; the same task without rationale fails

**Dependencies:** `WFQ-009`

### WFQ-009 — Add a per-task plausibility check before applying planner-supplied risk/boundary stamps to dispatch

**Priority:** P1 · **Program:** PROGRAM-06 · **Risk:** low · **Scope:** small

**Problem:** prepare_delegation gives explicit planner riskTier/boundaryTouching stamps unconditional precedence over heuristics (by design, per #1636). The v2.12 child plan copied feature-level criticality into all 17 per-task stamps (all high, all boundaryTouching:true), and the lead passed those values through explicitly, so every task received the maximum verification profile regardless of its actual blast radius (e.g. pure selectors and repository scripts).

**Impact:** Confirmed-correct precedence behavior (#1636) becomes harmful when upstream planning data is wrong, because nothing downstream challenges an implausible blanket stamp. This compounds every other gate cost in the run. PRODUCT/PROCESS DESIGN GAP, not a regression of #1636 itself.

**Proposed change:** Add an advisory-first plausibility check in prepare_delegation (or the decomposition gate, see WFQ-007) that flags when more than a configured percentage of tasks in a plan share an identical explicit riskTier/boundaryTouching stamp, and surfaces a warning requiring the lead to confirm or override per-task before dispatch. Do not change the #1636 precedence rule itself; add a check upstream of it.

**Evidence**
- 2026-07-21-phase-gate-v212-dogfood.md:16-21,427-439 (UE-1)
- servers/exarchos-mcp/src/verbs/team/prepare-delegation.ts:83-90,267-311 (planner-precedence logic, per report citation)

**Target files**
- `servers/exarchos-mcp/src/verbs/team/prepare-delegation.ts`
- `servers/exarchos-mcp/src/verbs/check-task-decomposition.ts`

**Acceptance proof**
- A test plan with 17/17 identical high/boundaryTouching stamps triggers a blanket-stamp warning at plan or prepare_delegation time
- A test plan with varied, task-specific stamps produces no warning

**Dependencies:** None

### WFQ-012 — Add a capability-aware fallback and accurate documentation for serialize_merge / merge-pending

**Priority:** P1 · **Program:** PROGRAM-06 · **Risk:** medium · **Scope:** medium

**Problem:** skills-src/delegate/SKILL.mds merge guidance omits the now-required dryRun: false (serialize_merge defaults to dry-run), and the action is declared shared-mutating so a read-only caller (e.g. this Copilot CLI session) is denied even for the dry-run path, with no documented local-git fallback. Every merge in the dogfood run required manual rebase/merge/state bookkeeping instead.

**Impact:** The merge-pending playbook assumes a caller that can execute shared-mutating actions; it has no capability-aware fallback, so read-only callers cannot complete the documented workflow at all. DOCUMENTATION BUG + PRODUCT CAPABILITY GAP (missing fallback path).

**Proposed change:** Generate merge instructions from the runtimes actual capability posture (shared-mutating vs read-only caller) rather than one fixed skill example, including the correct required dryRun value for the current default. Document and implement an explicit local-git fallback path (manual rebase/merge with equivalent state bookkeeping/event emission) for read-only callers, so merges do not silently fall outside the tracked workflow lifecycle.

**Evidence**
- 2026-07-21-phase-gate-v212-dogfood.md:387-401 (DOC-4), :141-142,149-151 (playbook adherence table)

**Target files**
- `skills-src/delegate/SKILL.md`
- `servers/exarchos-mcp/src/verbs/serialize-merge.ts`

**Acceptance proof**
- A read-only-caller test path exercises the documented fallback and asserts merge state/events are still recorded equivalently to serialize_merge
- Skill doc example is asserted (via a doc-drift test) to include the schema-required dryRun value matching the actions actual default

**Dependencies:** None

### WFQ-014 — Reconcile Bun-dependent test toolchain resolution between workspaces (environment/tooling blocker)

**Priority:** P1 · **Program:** PROGRAM-06 · **Risk:** low · **Scope:** small

**Problem:** servers/exarchos-mcp/vitest.config.ts aliases bun:sqlite to a Node shim purely so Vitest (which runs under Node) can execute suites that the compiled binary will run under real Bun; the root vitest.config.ts unit/integration projects run under npm run test:unit and do not carry the same alias. Current test evidence reports Bun absent for two suites on this host, meaning those suites cannot execute their real-runtime path at all in this environment.

**Impact:** ENVIRONMENT/TOOLING BLOCKER, not a product logic defect: on hosts without a Bun installation, any suite whose test-relevant behavior depends on the real bun:sqlite binding (as opposed to the Node shim) cannot be validated end-to-end, silently narrowing what tests passed actually proves on this host.

**Proposed change:** Document (in ONBOARDING.md/CONTRIBUTING.md and CI) which suites require a real Bun runtime versus which are safely covered by the Node shim, and gate/skip those suites explicitly with a clear Bun not installed diagnostic rather than an ambiguous failure. Consider adding a CI lane that runs the Bun-dependent suites under actual Bun to retain end-to-end coverage of the compiled-binary path.

**Evidence**
- servers/exarchos-mcp/vitest.config.ts confirmed at candidate SHA: bun:sqlite alias comment states the compiled binary still imports the real bun:sqlite at runtime; the alias is test-only
- Current test evidence (given input): Bun absent for two suites on this host

**Target files**
- `servers/exarchos-mcp/vitest.config.ts`
- `ONBOARDING.md`
- `.github/workflows/ci.yml`

**Acceptance proof**
- Running the full suite on a host without Bun produces an explicit, clearly-labeled skip/diagnostic for the Bun-dependent suites instead of an opaque failure
- CI runs at least one lane with real Bun covering the bun:sqlite production path

**Dependencies:** None

## P2 implementation backlog

### ART-009 — Record event-store schema/build identity for local SQLite cache freshness verification

**Priority:** P2 · **Program:** PROGRAM-07 · **Risk:** low · **Scope:** medium

**Problem:** Event schemas in servers/exarchos-mcp/src/event-store/schemas.ts are versioned per-event, but no located store/package identity marker proves a local SQLite event store was produced by the pinned candidate; disposition is open.

**Impact:** Startup cannot explicitly distinguish an incompatible/stale local event store from one produced by the current package version, risking silent schema drift.

**Proposed change:** Add a store metadata table/row recording packageVersion, schemaVersion, createdBySha at store creation, and have startup explicitly report incompatible-or-stale stores rather than relying solely on per-event upcast logic.

**Evidence**
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/artifacts.json row artifact.event-store-schema-identity (disposition open)

**Target files**
- `servers/exarchos-mcp/src/event-store/schemas.ts`
- `servers/exarchos-mcp/src/storage/sqlite-backend.ts`

**Acceptance proof**
- New store-metadata row visible via a diagnostic query/CLI command reporting packageVersion/schemaVersion/createdBySha
- Startup log/error explicitly names incompatible or stale stores in a test fixture

**Dependencies:** None

### ART-013 — Add a CI-enforced installed-cache freshness gate (currently enforcementPosture none)

**Priority:** P2 · **Program:** PROGRAM-05 · **Risk:** medium · **Scope:** medium

**Problem:** Both artifact.installed-skill-cache and artifact.plugin-cache have enforcementPosture none/indeterminate; there is no post-install freshness gate anywhere in CI or the installer to catch cache drift automatically.

**Impact:** Cache drift (as already observed: 0/3 byte matches) can persist indefinitely without any automated signal, relying entirely on manual audits like this one.

**Proposed change:** Add scripts/check-installed-cache-freshness.mjs invoked by a new npm script (cache:verify) that hashes installed skill/plugin cache entries against the currently-installed package version shipped hashes and fails/reports drift explicitly; wire into scripts/enforcer-wiring-manifest.json as a new advisory-then-gating primary.

**Evidence**
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/artifacts.json row artifact.installed-skill-cache (ownerControl.ciPosture: no post-install freshness gate)
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/artifacts.json row artifact.plugin-cache (ownerControl.ciPosture: no confirmed local cache verifier)

**Target files**
- `scripts/check-installed-cache-freshness.mjs (new)`
- `package.json`
- `scripts/enforcer-wiring-manifest.json`

**Acceptance proof**
- npm run cache:verify reports exact match/stale/modified for every installed skill and plugin cache entry, non-zero exit on unexplained drift
- New primary appears in scripts/enforcer-wiring-manifest.json and passes scripts/check-enforcer-wiring.mjs

**Dependencies:** `ART-006`, `ART-007`

### BASE-003 — Decompose the highest-risk composition-root and registry hotspots

**Priority:** P2 · **Program:** PROGRAM-07 · **Risk:** high · **Scope:** large

**Problem:** The snapshot has 71 production TypeScript files above 500 lines and 21 above 1,000 lines; registry.ts and event-store/schemas.ts exceed 4,100 lines, while multiple tools/composition roots exceed 2,000.

**Impact:** Large ownership surfaces make independent proof, review, code generation, and safe replacement harder even when line count alone is not a defect.

**Proposed change:** Use the contract/effect ownership work to split generated declarations, dispatch tables, persistence ports, and projection handlers into independently testable modules; do not split by arbitrary line limits.

**Evidence**
- codebase-metrics.json: largeProductionFiles
- registry.ts=4205 lines
- event-store/schemas.ts=4124 lines
- storage/sqlite-backend.ts=2700 lines
- views/tools.ts=2224 lines
- workflow/tools.ts=2033 lines

**Target files**
- `servers/exarchos-mcp/src/registry.ts`
- `servers/exarchos-mcp/src/event-store/schemas.ts`
- `servers/exarchos-mcp/src/storage/sqlite-backend.ts`
- `servers/exarchos-mcp/src/views/tools.ts`
- `servers/exarchos-mcp/src/workflow/tools.ts`

**Acceptance proof**
- Dependency-direction tests enforce the new module boundaries
- Public action/schema parity is unchanged
- No new circular imports or duplicate contract declarations

**Dependencies:** `API-001`, `CTR-013`, `WFQ-016`

### BASE-004 — Complete downstream v3 cutover after authority and structural programs land

**Priority:** P2 · **Program:** PROGRAM-07 · **Risk:** high · **Scope:** large

**Problem:** The lowering ledger includes implementation, migration, compatibility, and retirement work that should not block authority decisions but must be completed before v3 ships.

**Impact:** Without a separate downstream cutover item, authority work and implementation closure become one circular dependency and the roadmap cannot express progress honestly.

**Proposed change:** After Programs 01-06 establish authoritative state, contracts, effects, proof, and workflow semantics, close the remaining lowering rows with migration, compatibility, dogfood, and retirement evidence.

**Evidence**
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/v3-lowering.json: 30 mechanisms, 2 closed, 18 partial, 9 open, 1 indeterminate
- CTR-012 isolates prerequisite authority decisions

**Target files**
- `docs/audits/2026-07-23-structural-closure-delta-audit/v3-lowering.json`
- `docs/specs/2026-07-21-phase-gate-transition-admission-roadmap.md`
- `docs/specs/2026-07-21-phase-gate-transition-admission-roadmap-traceability.md`

**Acceptance proof**
- The active lowering ledger has zero partial, open, or indeterminate rows; retired mechanisms are removed from the active ledger and recorded with completed migration/retirement proof.
- A v3 migration/dogfood run proves compatibility or an explicit breaking retirement for every mechanism.

**Dependencies:** `CTR-012`, `EFF-001`, `API-001`, `ART-011`, `WFQ-004`

### CTR-013 — Add a generated action-to-handler-to-effect-to-package reachability graph as a CI-blocking artifact

**Priority:** P2 · **Program:** PROGRAM-07 · **Risk:** medium · **Scope:** medium

**Problem:** The audit had to externally construct a 1076-node/1065-edge action/projection graph because the repository does not ship or gate on a unified action-to-handler-to-effect-to-package graph.

**Impact:** Without a repository-owned reachability graph, integration completeness (Principle 4) can only be assessed by an external one-off audit; regressions in dispatch wiring, dead handlers, or unreachable actions are not caught structurally between audits.

**Proposed change:** Port the audit AST extraction into a repository-owned generator that classifies every handler as pure/read-only or effectful, resolves exact handlers, and links effectful handlers to typed owners. Emit the graph as a CI artifact and fail on missing classifications, missing handlers, or effectful handlers without owners.

**Evidence**
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/ship-surface.json nodeCount=1076
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/ship-surface.json edgeCount=1065

**Target files**
- `scripts/generate-ship-surface-graph.ts (new)`
- `package.json`

**Acceptance proof**
- CI fails when an action has no exact handler, a handler has no pure/effectful classification, or an effectful handler has no typed effect owner.
- Negative fixtures cover both a missing classification and a missing effect owner; a pure/read-only handler passes without an effect edge.
- The generated graph is deterministic and reconciles action, standalone CLI, and projection cardinalities.

**Dependencies:** `API-001`, `ART-004`

### CTR-015 — Retire the manual delta-audit inventories once generated equivalents (CTR-001/006/013) supersede them, with recorded exit proof

**Priority:** P2 · **Program:** PROGRAM-07 · **Risk:** low · **Scope:** small

**Problem:** The current remediation evidence base (contracts.json, ship-surface.json, v3-lowering.json, effects.json, artifacts.json) is a manually-produced, point-in-time audit rather than a continuously regenerated artifact; the audit's own recommendation is to keep the audit graph as a ratchet until generation replaces it, but no retirement condition or automated supersession check exists yet.

**Impact:** Without an explicit retirement trigger, the manual audit JSON risks becoming stale ground truth that future work cites instead of re-deriving, reintroducing the exact parallel-representation problem (SF-01) the backlog is meant to close.

**Proposed change:** Add a dated retirement condition to docs/audits/2026-07-23-structural-closure-delta-audit.md and manifest.json stating the manual inventories are superseded once scripts/generate-ship-surface-graph.ts (CTR-013) and contracts:guard (CTR-001) both pass in CI for two consecutive release cycles; add a CI check that warns if the manual audit files are referenced in code/comments after that date.

**Evidence**
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit.md: Retire temporary controls by evidence recommendation
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/manifest.json

**Target files**
- `docs/audits/2026-07-23-structural-closure-delta-audit.md`
- `docs/audits/2026-07-23-structural-closure-delta-audit/manifest.json`

**Acceptance proof**
- Manifest updated with an explicit machine-checkable retirement condition and owner
- CI check confirms no production source references the manual audit JSON as a runtime authority

**Dependencies:** `API-001`, `CTR-013`

### EFF-015 — Consolidate structured error carriers and dry-run interception proof across effect chokepoints

**Priority:** P2 · **Program:** PROGRAM-04 · **Risk:** low · **Scope:** medium

**Problem:** Event-store, gate, and storage effects each define their own structured error carrier (concurrency-error.ts, storage-busy-error.ts, session-errors.ts, EVIDENCE_APPEND_FAILED), and git/worktree mutation advertises dry-run interception, but there is no single cross-cutting proof that every effect chokepoint (event append, gate evidence, artifact write, git mutation, VCS mutation, filesystem write) exposes both a typed error carrier and a working dry-run/no-op mode before committing an effect.

**Impact:** Inconsistent error-carrier shapes across effect owners make it harder for callers (orchestrate actions, CLI) to distinguish retryable from terminal failures generically, and unproven dry-run coverage on some effect owners risks accidental mutation during planning/preview operations.

**Proposed change:** Define one shared structured-error base contract (retryable vs terminal, machine-readable code) that each effect owner error type extends, and add a matrix test enumerating every effect chokepoint (event append, gate evidence, artifact CAS write, git mutation, VCS mutation, config/skill filesystem write) asserting it exposes a typed error and, where mutation is user-triggerable pre-commit, a verified dry-run/no-op path.

**Evidence**
- 13cf9642:servers/exarchos-mcp/src/event-store/concurrency-error.ts
- 13cf9642:servers/exarchos-mcp/src/event-store/storage-busy-error.ts
- 13cf9642:servers/exarchos-mcp/src/event-store/session-errors.ts
- authoring audit artifact: docs/audits/2026-07-23-structural-closure-delta-audit/effects.json#rows[orchestrate.git-worktree-merge] (dry-run/recovery machinery noted as owner-specific)

**Target files**
- `servers/exarchos-mcp/src/event-store/concurrency-error.ts`
- `servers/exarchos-mcp/src/event-store/storage-busy-error.ts`
- `servers/exarchos-mcp/src/event-store/session-errors.ts`
- `servers/exarchos-mcp/src/verbs/vcs/git-exec-default.ts`

**Acceptance proof**
- Matrix test enumerates every declared effect chokepoint and asserts a typed retryable/terminal error carrier
- Matrix test asserts dry-run mode (where applicable) performs zero mutation while still returning a representative typed result

**Dependencies:** `EFF-003`, `EFF-010`

### WFQ-010 — Split spec_coverage_check into plan-syntax validation and post-implementation coverage validation

**Priority:** P2 · **Program:** PROGRAM-06 · **Risk:** low · **Scope:** medium

**Problem:** spec_coverage_check fails when a plan describes tests that implementation tasks are expected to create, because the plan-time gate requires the referenced test files to already exist on disk before any task has run.

**Impact:** A plan-time gate cannot pass for any plan that legitimately proposes new test files, forcing authors to either pre-create empty test stubs or skip the gate. Design conflict between plan-time and implementation-time concerns. PRODUCT CODE/DESIGN BUG.

**Proposed change:** Split the action into two: (1) plan syntax validation, checking that test paths/names are well-formed and declared in the plan; (2) implementation coverage validation, checking that the declared files exist and pass after task completion. Wire (1) into the plan-review phase and (2) into task-completion or the wave-boundary gate.

**Evidence**
- 2026-07-21-phase-gate-v212-dogfood.md:337-349 (CB-9)

**Target files**
- `servers/exarchos-mcp/src/verbs/gates/spec-coverage-check.ts`
- `servers/exarchos-mcp/src/runbooks/definitions.ts`

**Acceptance proof**
- A plan referencing not-yet-created test files passes the plan-syntax variant and is rejected only if malformed
- The same plan, after task completion, is validated by the implementation-coverage variant which fails if the declared test files are still missing

**Dependencies:** None

### WFQ-011 — Correct delegate/plan SKILL.md claims that contradict registered action behavior and schemas

**Priority:** P2 · **Program:** PROGRAM-06 · **Risk:** low · **Scope:** medium

**Problem:** Three confirmed doc/behavior mismatches: (1) skills-src/delegate/SKILL.md:98 states the prepare_delegation composite action creates .worktrees/task-<id> and runs npm install, but the registered action description is query delegation readiness with no worktree creation observed; (2) the delegate skills worktree path convention (.worktrees/task-<id>) contradicts setup-worktree.ts actual convention (taskId-taskName, i.e. .worktrees/<taskId>-<taskName>), so manually created worktrees using the documented convention were not recognized by setup_worktree; (3) plan/SKILL.mds example passes threshold: 80 for spec_coverage_check where the schema expects a 0-1 fraction, producing a live Too big: expected number to be <=1 error.

**Impact:** Agents and leads following the documented conventions hit avoidable runtime errors and path-mismatch failures, adding manual recovery work exactly as observed in the dogfood run. DOCUMENTATION BUG (not a runtime defect in the actions themselves, aside from the underlying path-convention duplication addressed via a shared generator).

**Proposed change:** Remove the worktree-creation claim from prepare_delegations skill documentation (or replace with an explicit call to setup_worktree / a statement of native-isolation responsibility). Introduce one canonical worktree ID/path generator function shared by the skill docs, setup_worktree, the readiness view, and event payloads, and regenerate/lint the skill docs path examples from it. Fix the plan skills threshold example to 0.8 and add a generated schema-doc consistency test that fails when a skill example value violates the referenced actions schema.

**Evidence**
- 2026-07-21-phase-gate-v212-dogfood.md:352-386 (DOC-1, DOC-2, DOC-3)
- skills-src/delegate/SKILL.md:98 confirmed at candidate SHA
- servers/exarchos-mcp/src/verbs/team/setup-worktree.ts confirmed at candidate SHA: worktreeName built from taskId-taskName
- skills-src/plan/SKILL.md threshold: 80 example confirmed at candidate SHA

**Target files**
- `skills-src/delegate/SKILL.md`
- `skills-src/plan/SKILL.md`
- `servers/exarchos-mcp/src/verbs/team/setup-worktree.ts`
- `servers/exarchos-mcp/src/views/delegation-readiness-view.ts`

**Acceptance proof**
- A generated-doc drift test parses skill examples against the referenced actions Zod schema and fails on out-of-range values (catches the threshold:80 case)
- A shared path-generator unit test asserts the skill docs documented path and setup_worktrees actual path are produced by the same function
- Manual/e2e check: a worktree created via the documented convention is recognized by setup_worktree without a second-path retry

**Dependencies:** None

### WFQ-013 — Fix or document the invalid top-level mutation key in .exarchos.yml

**Priority:** P2 · **Program:** PROGRAM-06 · **Risk:** low · **Scope:** small

**Problem:** The committed .exarchos.yml declares a top-level mutation: key pointing at the Stryker adapter script, but schema validation reports unrecognized_keys: mutation because mutation is only valid nested under a toolchains commands, not as a top-level key.

**Impact:** Repeated validation noise in agent and gate output, which can obscure genuine configuration failures during a run. DOCUMENTATION/CONFIG SCHEMA MISMATCH.

**Proposed change:** Either move the mutation command into a valid toolchains.<name>.commands.mutation entry matching the documented schema, or extend the config schema to explicitly support a top-level mutation override key if that is the intended design, and document the choice.

**Evidence**
- 2026-07-21-phase-gate-v212-dogfood.md:402-412 (DOC-5)
- .exarchos.yml:4-11 confirmed at candidate SHA: top-level mutation: node servers/exarchos-mcp/scripts/stryker-adapter.mjs

**Target files**
- `.exarchos.yml`
- `servers/exarchos-mcp/src/config/schema.ts`

**Acceptance proof**
- Config validation against the committed .exarchos.yml produces zero unrecognized_keys warnings
- A schema test pins the resolved location of the mutation command (top-level vs nested) so future edits cannot silently regress

**Dependencies:** None

### WFQ-015 — Audit and raise/normalize test timeouts across root vitest projects to eliminate environment-driven flakiness

**Priority:** P2 · **Program:** PROGRAM-07 · **Risk:** low · **Scope:** medium

**Problem:** The root vitest.config.ts sets explicit testTimeout overrides for the process (15000ms) and outcome (30000ms) projects, but the unit/integration projects (which run via npm run test:unit, the default test:run target) have no explicit testTimeout override and fall back to Vitests 5000ms default. Current evidence reports nine 5-second timeouts in the full root run.

**Impact:** ENVIRONMENT/TOOLING-SENSITIVE, likely a config gap rather than a product logic bug: slower CI/dev hosts or resource contention can push otherwise-correct tests past a 5s default, producing false failures that are indistinguishable from real regressions without manual triage.

**Proposed change:** Identify which of the nine timing-out tests are inherently slow (I/O, subprocess, filesystem) versus genuinely hung/broken. For legitimately slow-but-correct tests, set an explicit per-test or per-project testTimeout (consistent with the existing process/outcome pattern) rather than relying on the 5000ms default. For any test masking a real hang, fix the underlying blocking call.

**Evidence**
- vitest.config.ts (root) confirmed at candidate SHA: process/outcome projects have explicit testTimeout; unit/integration projects do not
- Current test evidence (given input): 11 failed, nine 5-second timeouts in the full root run

**Target files**
- `vitest.config.ts`
- `servers/exarchos-mcp/src/**/*.test.ts`

**Acceptance proof**
- A full root test:run on the reference host completes with zero timeout-attributed failures
- Each previously-timing-out test file has either an explicit justified timeout override or a fix removing the slow blocking call, documented in the test file

**Dependencies:** None

### WFQ-016 — Expand module ownership/dependency-direction rules beyond the single Dependency Cruiser domain-adapter rule

**Priority:** P2 · **Program:** PROGRAM-07 · **Risk:** medium · **Scope:** large

**Problem:** Per the structural-principles assessment, Dependency Cruiser expresses exactly one domain-to-adapter rule (event-store/workflow domain code must not import transport adapters); it does not express ownership of every mutable state surface, allowed dependencies per major module, forbidden internal imports across every boundary, or public contracts/effect ports per module. Many handlers accept broad contexts (DispatchContext, EventStore) rather than minimal effect ports, so the true effect surface is wider than declared module inputs suggest.

**Impact:** Module boundaries are provable only in the few places explicitly wired, not repository-wide; cross-module state/effect access can be introduced without triggering any mechanical check, and the codebase cannot currently compute reverse dependencies to detect undeclared coupling. STRUCTURAL/DEAD-CODE-RATCHET GAP (Principle 3, R-8).

**Proposed change:** Declare, per major subsystem (event-store, workflow domain, orchestrate/pure, views, storage, registry), an explicit ownership manifest of mutable state surfaces, allowed dependency directions, and permitted effect ports. Extend Dependency Cruiser rules (or an equivalent static check) to cover each declared boundary, and narrow broad-context handler signatures (DispatchContext, EventStore) to minimal ports where feasible. Wire a reverse-dependency computation so undeclared cross-module state/effect access fails a check rather than passing silently.

**Evidence**
- 2026-07-21-structural-principles-codebase-assessment.md:203-251 (Principle 3, score 2), :645-649 (R-8)

**Target files**
- `.dependency-cruiser.cjs`
- `servers/exarchos-mcp/src/architecture/`

**Acceptance proof**
- A new module-ownership manifest file exists and is validated by a test/script that fails when an undeclared cross-module import or effect access is introduced
- At least one broad-context handler is refactored to a minimal effect port as a worked example, with a regression test pinning the narrower signature

**Dependencies:** None

### WFQ-017 — Publish and execute a promotion plan for advisory/audit-mode ratchets, with explicit retirement criteria

**Priority:** P2 · **Program:** PROGRAM-07 · **Risk:** low · **Scope:** large

**Problem:** The structural-principles assessment identifies that 9 of 13 invariant-catalog entries with explicit enforcement modes are audit-only (model-judgment, not deterministic), and several named ratchets remain advisory/non-blocking: mutation adequacy (observe mode pending StrykerJS dry-run reliability and issue #1720), INV-6 lint (exit code intentionally swallowed), benchmark regression (non-blocking), and capability evals (non-blocking). The enforcer-wiring manifest correctly records these as advisory (an honesty strength), but the underlying verification gaps remain open.

**Impact:** A large fraction of we checked outcomes do not actually block a bad change from proceeding; without a tracked promotion plan, these controls can remain permanently advisory rather than being promoted once their stated exit conditions are met. STRUCTURAL/PROCESS GAP (Principle 5/7, R-7).

**Proposed change:** For each advisory/audit-mode control, record its concrete exit condition (already partly documented, e.g. #1720 for mutation adequacy) in one tracked backlog/issue with an owner and target date. Promote each control to blocking/fail-closed as its exit condition is met, verified by a kill-probe/negative-control test proving the promoted check actually fails closed on a seeded defect (consistent with the existing seeded-defect corpus pattern).

**Evidence**
- 2026-07-21-structural-principles-codebase-assessment.md:379-400,502-520,634-643 (R-7)
- scripts/enforcer-wiring-manifest.json confirmed at candidate SHA: mutation-gate entry disposition advisory with rationale citing issue #1720 as its own exit condition

**Target files**
- `scripts/enforcer-wiring-manifest.json`
- `servers/exarchos-mcp/src/evals/benchmarks/seeded-defects/corpus.ts`
- `.exarchos/invariants.md`

**Acceptance proof**
- Each of the four named advisory ratchets (mutation adequacy, INV-6 lint, benchmark regression, capability evals) has a tracked issue with an explicit exit condition and owner
- At least one promoted control (e.g. mutation adequacy once #1720 resolves) has a passing kill-probe test proving it fails closed on a seeded defect, and its enforcer-wiring-manifest disposition is updated from advisory to gating

**Dependencies:** None

### WFQ-018 — Require skills to emit meta/feedback on repeated or systemic failure, and codify a stop-and-simplify escalation rule

**Priority:** P2 · **Program:** PROGRAM-07 · **Risk:** low · **Scope:** small

**Problem:** meta/feedback contained zero events despite at least 25 explicit tool errors during the dogfood run, so friction evidence had to be reconstructed after the fact from raw traces. Separately, the lead worked around readiness, worktree, gate, merge, and event-store defects one-by-one across the entire run instead of pausing after the first repeated infrastructure defect to simplify the execution mode.

**Impact:** Real-time signal about systemic tool/runtime failures is lost, and there is no codified trigger for a lead/orchestrator to stop delegating and switch to a simpler, more supervised execution path after clear evidence of compounding harness defects. PROCESS/SKILL DESIGN GAP.

**Proposed change:** Add an explicit skill instruction (delegate/task-completion playbooks) that after N repeated failures of the same action/gate within a workflow, the agent must call exarchos_workflow feedback before retrying further, and must recommend to the lead pausing delegation in favor of direct/local completion with scoped tests. Wire this as a checked step, not only prose guidance, where feasible (e.g. a counter surfaced in the readiness/telemetry view that flags repeated failure, consider escalation).

**Evidence**
- 2026-07-21-phase-gate-v212-dogfood.md:478-486 (T-4), :441-451 (UE-2)

**Target files**
- `skills-src/delegate/SKILL.md`
- `servers/exarchos-mcp/src/views/telemetry-view.ts`

**Acceptance proof**
- A simulated run with 3+ repeated failures of the same action triggers a feedback-emission reminder/requirement surfaced to the caller
- Skill documentation includes an explicit stop-and-simplify escalation rule with a concrete trigger threshold

**Dependencies:** `EFF-001`, `WFQ-002`, `WFQ-003`

## Historical provenance appendix

The report originated from the comparison between baseline
`30831d05f67c44b80e45391b67ed29f11dda4276` and candidate
`13cf9642b9c3ec5dec5a4bcfdbfc5ac6904a75f5`. That history remains useful
for evidence provenance and chronology correction, but implementation priority
is based on the candidate snapshot's current condition, native gate results,
and remediation dependencies.

### Seven-principle provenance delta

| Principle | Baseline | Candidate | Delta | July 21 | Judgment / residual gap | Evidence / backlog |
|---:|---:|---:|---:|---:|---|---|
| 1 | 2 | 2 | +0 | 2 | Baseline and candidate both have runtime schemas and generated content guards, but neither has one public IDL. | contracts:contract.output-schema-enforcement; PROGRAM-03 |
| 2 | 2 | 3 | +1 | 3 | Baseline has pure folds and typed seams; candidate adds proof ADTs, evidence subjects, durable gate evidence, and CAS artifacts. | lowering:M002-M005; effects:gate.evidence-append |
| 3 | 2 | 2 | +0 | 2 | Both snapshots have real module seams, but ownership and independently provable contracts are not universal. | codebase-metrics:largeProductionFiles; BASE-003 |
| 4 | 2 | 2 | +0 | 2 | Candidate adds gate ownership registries/census, but neither snapshot ships a unified reachability graph. | effects:gate.ownership-census; CTR-013 |
| 5 | 3 | 3 | +0 | 3 | The verification ladder remains systematic in both snapshots; candidate gate failures and sparse packaged proof prevent a higher score. | PROGRAM-02; PROGRAM-06 |
| 6 | 1 | 2 | +1 | 2 | Baseline lacks subject-bound durable gate proof; candidate adds it but does not make proof universal or bind installed artifacts to source. | PROGRAM-01; PROGRAM-05 |
| 7 | 3 | 3 | +0 | 3 | Both snapshots have substantial ratchets; candidate adds ownership census but retains advisory and legacy exits. | codebase-metrics:enforcement; PROGRAM-07 |
| **Total** | **15/28** | **17/28** | **+2** | **17/28** | **The gain is concentrated in explicit proof/effect structure; contract, integration, and artifact closure remain open.** | **Programs 01-07** |

### Historical Principle 1

- **Baseline:** 2/4
- **Candidate/current audited snapshot:** 2/4
- **Delta:** +0
- **July 21 candidate assessment:** 2/4
- **Judgment:** Baseline and candidate both have runtime schemas and generated content guards, but neither has one public IDL.
- **Evidence / residual target:** contracts:contract.output-schema-enforcement; PROGRAM-03

### Historical Principle 2

- **Baseline:** 2/4
- **Candidate/current audited snapshot:** 3/4
- **Delta:** +1
- **July 21 candidate assessment:** 3/4
- **Judgment:** Baseline has pure folds and typed seams; candidate adds proof ADTs, evidence subjects, durable gate evidence, and CAS artifacts.
- **Evidence / residual target:** lowering:M002-M005; effects:gate.evidence-append

### Historical Principle 3

- **Baseline:** 2/4
- **Candidate/current audited snapshot:** 2/4
- **Delta:** +0
- **July 21 candidate assessment:** 2/4
- **Judgment:** Both snapshots have real module seams, but ownership and independently provable contracts are not universal.
- **Evidence / residual target:** codebase-metrics:largeProductionFiles; BASE-003

### Historical Principle 4

- **Baseline:** 2/4
- **Candidate/current audited snapshot:** 2/4
- **Delta:** +0
- **July 21 candidate assessment:** 2/4
- **Judgment:** Candidate adds gate ownership registries/census, but neither snapshot ships a unified reachability graph.
- **Evidence / residual target:** effects:gate.ownership-census; CTR-013

### Historical Principle 5

- **Baseline:** 3/4
- **Candidate/current audited snapshot:** 3/4
- **Delta:** +0
- **July 21 candidate assessment:** 3/4
- **Judgment:** The verification ladder remains systematic in both snapshots; candidate gate failures and sparse packaged proof prevent a higher score.
- **Evidence / residual target:** PROGRAM-02; PROGRAM-06

### Historical Principle 6

- **Baseline:** 1/4
- **Candidate/current audited snapshot:** 2/4
- **Delta:** +1
- **July 21 candidate assessment:** 2/4
- **Judgment:** Baseline lacks subject-bound durable gate proof; candidate adds it but does not make proof universal or bind installed artifacts to source.
- **Evidence / residual target:** PROGRAM-01; PROGRAM-05

### Historical Principle 7

- **Baseline:** 3/4
- **Candidate/current audited snapshot:** 3/4
- **Delta:** +0
- **July 21 candidate assessment:** 3/4
- **Judgment:** Both snapshots have substantial ratchets; candidate adds ownership census but retains advisory and legacy exits.
- **Evidence / residual target:** codebase-metrics:enforcement; PROGRAM-07


## Evidence artifacts

- `docs/audits/2026-07-23-structural-closure-delta-audit/manifest.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/contracts.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/effects.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/ship-surface.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/artifacts.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/v3-lowering.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/codebase-metrics.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/remediation-backlog.json`
- `docs/audits/2026-07-23-structural-closure-delta-audit/api-contract-codegen.json`
