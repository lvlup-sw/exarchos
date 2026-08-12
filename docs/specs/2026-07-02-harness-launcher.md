# Spec: Harness Launcher — cross-harness Exarchos lifecycle abstraction (`exarchos <harness>`)

**Date:** 2026-07-02 · **Feature:** `harness-launcher` · **Depth:** deep
**Inputs:**
- Issue `#1603` — **redefined** from "spatial enforcement chokepoint" to the Exarchos *lifecycle* launcher (see §Design; the space-moat is handed to #1601 per three refuted plan-reviews).
- Epic `#1601` — Standards-first harness agnosticism (conform-and-shrink + chokepoint enforcement).
- Composes epic `#1574` (WLM): foundation (PR #1628) + operational-core (`#1577`/`#1578`, PR #1631) — this launcher is the **producer/actuator** the WLM tracks, verifies, and serializes for.
- ADR: [`docs/adrs/2026-05-24-hook-layer-observe-only.md`](../adrs/2026-05-24-hook-layer-observe-only.md).

> **Re-scoped (rev. 3) after three 3/3-refuted plan-review rounds proved a local launcher cannot be a *space* chokepoint.** Every space claim collapsed (uniform prevention → uniform detection → pass-through-P) because the launcher owns neither the filesystem write path nor nested worktree creation. This spec drops space enforcement **entirely** (a non-goal — kernel/harness territory) and scopes the launcher to what it structurally *does* own: the **Exarchos process + top-level-worktree lifecycle**, produced as **state** through the one chokepoint we fully own, via **one shared abstraction** (no per-platform fan-out), **composing with — not replacing — the WLM**.

## Design & Rationale

### Problem Statement

Exarchos supports five Tier-1 harnesses (Claude Code, Codex, Cursor, Copilot, OpenCode). The invariants it can consistently enforce across all of them are exactly those whose *sole sanctioned path* runs through a chokepoint Exarchos owns:

- **State** — every harness mutates Exarchos state only via the **MCP dispatch handler**, so state integrity (INV-1/2/7/8/13) holds by construction, cross-harness. This is the core invariant to preserve.
- **Lifecycle** — the process + its top-level worktree, **if Exarchos owns the spawn**.

Today lifecycle is *not* owned uniformly: worktree handling is scattered (`setup-worktree`, `worktree-baseref`, `dispatch-guard`), `isolation:worktree` is rendered per-runtime, and there is no single cross-harness spawn/observe/teardown path — so lifecycle logic risks **N disconnected per-platform implementations that drift** (the exact render-parity-≠-enforcement-parity trap #1601 targets, applied to lifecycle instead of space).

Filesystem-write confinement (INV-11 "can't write outside the worktree") is **out of scope**: it lives on the kernel's path, which no local launcher owns. That is the harness's own sandbox (Codex) or the #1601 space-moat fork (upstream blocking-hook standard / remote-basileus) — **not** this launcher.

### Chosen Approach

`exarchos <harness>` — **one shared abstraction for the Exarchos lifecycle** across all five harnesses. It:

1. **Owns the spawn** — creates the top-level worktree (as event-sourced state), `chdir`s the child in, execs the harness, observes it via #1577 liveness events, and tears it down on exit (INV-15: spawn → exec → teardown, no daemon).
2. **Produces state, doesn't fabricate enforcement** — worktree ownership/creation/liveness are appended through the StreamLockManager single-writer path (INV-7); everything meaningful the launcher does is state flowing through the handler chokepoint, hence consistent by construction.
3. **Composes with the WLM, doesn't replace it** — the launcher owns creation of the worktree *it* spawns into; the WLM's `adopt`/`reconcile` (shipped) tracks worktrees the **harness** creates internally (e.g. Claude's `.claude/worktrees/agent-*` for its own subagents), the ground-truth probe verifies existence, and `serialize_merge` serializes integration merges. The launcher **produces** the events the WLM consumes and **consumes** the WLM's assignment + merge serializer — it re-homes nothing.
4. **Is one implementation, not N** — the lifecycle control flow is harness-agnostic; per-harness variation is confined to **declarative spawn descriptors** (command/args/cwd/env) and **one cross-OS spawn primitive**. A structural guard forbids per-harness branching in the lifecycle core (INV-4).

v1 ships all five Tier-1 harnesses, no fast-follow; `generic` is out of scope (no process to spawn).

### The chokepoint principle (what this scope rests on)

> **Exarchos consistently enforces an invariant across harnesses iff every harness's sole sanctioned path to the governed resource passes through a chokepoint Exarchos owns.**

| Resource | Sole-path owner | Consistent, by construction? |
|---|---|---|
| **State** (events, projections, ownership, liveness, merges) | the **event-store append substrate** (StreamLockManager / AtomicAppender) | **Yes** — the core invariant (this slice produces onto it) |
| **Process + top-level-worktree lifecycle** | **this launcher** (owns the spawn) | **Yes** — this slice's deliverable |
| Nested subagent worktrees the harness creates | the **harness** | tracked via WLM `adopt` (not owned — and that's sufficient) |
| **Filesystem writes** | the **kernel** | **No** — explicit non-goal (harness sandbox / #1601 fork) |

The state chokepoint is the **append substrate**, not any single facade over it: the MCP dispatch handler is the *agent-facing* sanctioned path (an agent mutates state only through MCP tools), and the launcher — a trusted first-party Exarchos writer — appends through the **same** StreamLockManager single-writer path (INV-7). Both converge on one serialized substrate; the launcher does not bypass state integrity, it is a first-party producer onto it.

### Evolution into a revised #1601

- **Conform-and-shrink** — unchanged.
- **State chokepoint (handler)** — enforces by construction, cross-harness. ✓
- **Lifecycle chokepoint (this launcher)** — enforces process + top-level-worktree lifecycle by construction, cross-harness, via **one abstraction** (INV-4: implemented once). ✓
- **Space is not an Exarchos-owned chokepoint locally.** Uniform filesystem-write enforcement is the #1601 fork — **(a)** drive harnesses to a standard *Bash-covering blocking pre-write hook*, or **(b)** run agents in a remote kernel sandbox (INV-3/INV-15). Explicitly **not** a launcher deliverable. The launcher composes with whatever isolation the harness provides itself and makes no space guarantee.
- **#1603 is redefined** from "spatial enforcement chokepoint" to "Exarchos lifecycle launcher"; the space-moat work moves to #1601 as the fork above (issue updates pending).

### Requirements (DR-N)

#### DR-1: `exarchos <harness>` launcher verb — the single lifecycle abstraction

Agent-first CLI verb spawning a Tier-1 harness through one shared spawn → place → observe → teardown path. Schema-constrained enum, Aspire-style, `--dry-run`-capable, states when *not* to use it (INV-5a/5c). No daemon (INV-15).

**Acceptance criteria:**
- `exarchos <harness> [--feature <id>] [--dry-run]` resolves `<harness>` from a schema enum of the five Tier-1 harnesses (`claude-code | codex | cursor | copilot | opencode`), mapping to runtime id (`claude-code` → `runtimes/claude.yaml`); unknown → structured error with `validTargets`.
- The **non-dry-run** path binds the verb to the lifecycle orchestrator (DR-6): create worktree → chdir → exec → teardown-once — asserted end-to-end, not just dry-run.
- `--dry-run` prints the derived worktree path and the event plan without creating a worktree or spawning. **No space-tier / enforcement claim appears in the output** (out of scope).
- No process, timer, or handle outlives the child (handle-snapshot assertion).

#### DR-2: Worktree lifecycle state — creation split + ownership + launch liveness

The launcher's real output is state on the substrate the handler owns, and the launcher worktree is a **top-level, task-less** harness-process worktree — a *distinct kind* from a delegation task worktree. It is therefore tracked through the WLM lifecycle family **`worktrees@v1` already folds** (`worktree.reserved` + the launch liveness pair), **not** through the task-scoped `worktree.created`. `WorktreeManager.reserve` emits a *single* `worktree.reserved` ownership event (carrying `worktreeId`, nullable `featureId`, `ownerPid`/`ownerStartedAt`, `operationId`) and does **not** run `git worktree add`; the launcher performs the actual top-level creation as an INV-13 intent/result pair with a **shared stem** — `worktree.create.requested` → **`worktree.create.executed`** (a new terminal, mirroring every shipped INV-13 pair: `pr.create.requested`/`pr.create.executed`, `worktree.remove.requested`/`worktree.remove.executed`) — both appended to the **singleton `worktrees` stream** so a crash-recovery precheck correlates them on ONE stream by `operationId`. Liveness needs **new concrete union members** (#1577 liveness is per-surface literals, not a discriminator).

> **Why not reuse `worktree.created` (rev. 4 correction):** `WorktreeCreatedData` requires `taskId`+`branch` (`schemas.ts:1492`), which a task-less `exarchos <harness>` launch cannot satisfy without a fabricated `taskId`; its named consumers are all **task-scoped** — delegation-readiness folds by `taskId` (a fabricated one pollutes the delegation-ready set), `workflow-state-projection` folds it to **identity** (a no-op), and `repoRoot:'auto'` resolves by `taskId`. Decisively, the `worktrees@v1` reducer that `exarchos_view{ps|worktrees}` reads **does not fold `worktree.created` at all** (`projections/worktrees.ts:352-371`, `default → identity`), so reuse would give the launcher **zero** `ps` visibility. Launcher visibility comes from `worktree.reserved` + `launch.*`, which the reducer *does* (will) fold. `worktree.created` is left untouched for the delegation path.

**Acceptance criteria:**
- **Ordering (no adopt-race):** `worktree.reserved` is appended **before** `git worktree add`, so the worktree is tracked in `worktrees@v1` (state `reserved`) before it exists on disk — closing the untracked-on-disk window a concurrent `adopt` (prune's adopt-gate, another launch) would otherwise race. Then `worktree.create.requested` (INV-13 intent, idempotency key `worktree.create.requested:<operationId>`) precedes the add, and `worktree.create.executed` is the terminal — **all three on the singleton `worktrees` stream**. A crash between intent and terminal is recovered by an idempotent precheck (worktree on disk? emit `worktree.create.executed` / skip : re-run the add).
- New concrete liveness members `launch.executing_started`/`launch.executed` (matching the INV-10 `<surface>.executing_started`/`.executed` pattern; "executed" = child exited). **`launch.executing_started` carries `worktreeId` + `holderPid`/`holderStartedAt`** (mirroring `InFlightMerge`, so the DR-6/Task-016 dead-holder reconciler is expressible) + data schemas + emission registry (all new types **`auto`**) + count-pin bump (**139 → 143**: `worktree.create.requested`, `worktree.create.executed`, `launch.executing_started`, `launch.executed`; `worktree.reserved`/`worktree.created` already exist) across **all three** `toHaveLength` sites (two in `event-store/schemas.test.ts`, one in `__tests__/event-store/schemas.test.ts`). The `worktrees@v1` reducer `switch` is **extended to fold `launch.*`** (today they hit its `default → identity` arm) so `exarchos_view{ps|worktrees}` reflects the launch **from events**.
- A test asserts all worktree-mutating git routes through the manager's git runner (not scattered `execFile`s); concurrent same-target creation is prevented by unique-sibling topology (DR-5) + the `<eventType>:<operationId>` idempotency key (the event-append lock serializes *appends*, not the git side-effect, which runs between intent and terminal — INV-7 covers the appends).

#### DR-3: Compose with the WLM — produce, verify-via-adopt, serialize-merge (don't replace)

The launcher is a producer/actuator; the shipped WLM does the tracking, verifying, and serializing — **including** for worktrees the launcher does not own.

**Acceptance criteria:**
- The launcher emits the **ownership (`worktree.reserved`) + liveness (`launch.*`)** events the WLM's `worktrees@v1` projection **folds**; `exarchos_view{worktrees|ps}` reflects launcher activity with no fresh scan. (The `worktree.create.*` pair is INV-13 creation **audit**, correlated by `operationId` for crash-recovery — a reducer no-op like `worktree.remove.requested`, **not** a projection input.)
- **Crisp create-vs-adopt boundary:** the classification rule — *launcher-spawned top-level worktree ⇒ launcher `reserve`+create; harness-created nested worktree ⇒ WLM `adopt`* — is pinned by a discriminating test: a launcher-created worktree (already `reserved`) is **not** re-adopted when a concurrent `adopt`/prune enumerates `git worktree list` (relies on and asserts the manager's adopt-idempotency "already tracked → skip" backstop); and a harness-created nested worktree **is** tracked via `adopt`.
- **`adopt`/`reconcile` is retained and reachable** — the launcher does **not** assume sole ownership of worktree creation.
- Integration merges route through the shipped `serialize_merge` (the launcher is a caller); the launcher re-homes neither `merge_orchestrate` nor the WLM projections.

#### DR-4: One shared abstraction — no per-platform fan-out

Lifecycle control flow is harness-agnostic; per-harness variation is declarative descriptors + one cross-OS spawn primitive (INV-4: implemented once).

**Acceptance criteria:**
- The spawn descriptor is a **pure-data type** — a closed shape of `command/args/cwd/env` (string/array/record) with **no function-typed fields** and no behavior hooks; this is asserted at the type level (the real invariant), so no per-harness behavior can hide inside a descriptor. Complementing it, a **structural guard test** asserts the lifecycle core has no harness-name branching (`if harness === 'codex'`-style forks or a `switch (harness)` dispatching behavior). Both together are the anti-drift check — the type pin is load-bearing; the text-scan is the backstop.
- A single async cross-OS spawn primitive (one interface over win32 `.cmd`/`.ps1` shim resolution + POSIX) serves all five harness CLIs, with no shell-injection hazard (cf. CVE-2024-27980).

#### DR-5: Sibling worktree topology — one level deep, never nested, on the creation path

**Acceptance criteria:**
- A pure `deriveWorktreePath` + nesting guard is **called by the creation task before `git worktree add`** (invoked on the path, asserted end-to-end) and reused by `--dry-run` for path derivation.
- Two concurrent launches create siblings off the same base; a nested target is refused with a structured error.

#### DR-6: Own the full lifecycle — signals, teardown, recovery

**Acceptance criteria:**
- **Signals:** the launcher traps `SIGINT`/`SIGTERM`, forwards to the child, guarantees teardown on parent interruption, and leaves no orphaned/detached child if the launcher dies.
- **Guaranteed liveness terminal:** `launch.executed` is emitted on **every catchable exit path** (normal exit, forwarded signal, teardown) — the terminal emission is owned by the lifecycle/teardown path, not only the happy path.
- **Phantom-launch reconciler (uncatchable death):** on `SIGKILL`/host death no terminal can be written, so the **on-demand ground-truth probe is extended to reconcile `launch.*`** — a `launch.executing_started` with no paired `launch.executed` whose holder PID is provably dead is reconciled to a terminal (the #1577 protected-ancestry-probe pattern applied to launches), so `ps` never folds a permanent phantom in-flight launch. Reuses the shipped probe seam; no polling.
- **Crash mid-spawn:** a crash after `worktree.create.requested` before exec is recovered by the DR-2 precheck; no orphaned half-created worktree escapes GC (dedicated test).
- **Teardown safety:** never `reset --hard`; uncommitted work preserved; `recoveryError` on unclean release (INV-14).
- **cwd-drift:** the launcher's own ancestry is excluded from the in-use set (reuse #1577 protected-ancestry probe).
- **Origin unreachable / non-git target:** fail-closed structured error.

#### DR-7: Authority-bounded ephemeral orientation-injection seam

An **ephemeral** orientation-injection seam (env / transient system-prompt append at spawn) mutating no repo files. It **declares** injected orientation as non-authoritative in its typed interface — the launcher does not own the model's prompt precedence, so it cannot *enforce* that orientation loses to user instructions; it can only *mark* it non-authoritative and place it where a well-behaved consumer treats it as such. Content/format owned by #1485.

**Acceptance criteria:**
- At spawn an orientation payload is injected via env/transient prompt with **no repo-file mutation**.
- The typed interface **tags** the payload as `orientation` (non-authoritative), distinct from any directive channel — a test asserts the tag/placement, **not** runtime precedence over the model (which the launcher cannot own).
- Absent a payload, launch is unchanged.

#### DR-8: Cross-OS portability + Windows lane

**Acceptance criteria:**
- The single spawn primitive (DR-4) resolves + launches harness CLIs on Windows (`.cmd`/`.ps1` global shims) and POSIX; worktree paths are `path.join`/`toPosix`-built and symlink-resolved (INV-16).
- A Windows CI lane runs the **named** win32-fragile tests — the async spawn shim resolution (DR-4) and worktree path derivation/containment (DR-5) — authored OS-native (not POSIX-literal mocks), and gates as a required check.

### Technical Design

New CLI entry (a process supervisor; the stdio MCP surface can't own a child's lifecycle), composing shipped substrate:

- **Creation & ownership** — `git worktree add` in the new `worktree.create.*` split (DR-2); ownership via existing `WorktreeManager.reserve`.
- **WLM composition** — emit the events `worktrees@v1` folds; consume assignment + `serialize_merge`; leave `adopt`/`reconcile` intact for harness-created worktrees.
- **Lifecycle core** — a harness-agnostic `runLifecycle(descriptor)` with declarative per-harness descriptors; one async cross-OS spawn primitive (`utils/process.ts`).
- **Liveness** — new `launch.*` members + `worktrees@v1` reducer fold (`verbs/worktree/projections/worktrees.ts`) + `ps` surfacing (`views/composite.ts`).
- **Teardown/recovery** — INV-14 discriminator + #1577 protected-ancestry probe.

**Not built (non-goals):** any filesystem-write confinement, boundary hooks, space-enforcement tiers, or deletion of `adopt`/`reconcile`/#1568. `#1568` and `#1301` are untouched by this slice.

### Integration Points

- `servers/exarchos-mcp/src/verbs/worktree/manager.ts` — new `reserve` caller; `adopt`/`reconcile` **retained**.
- `servers/exarchos-mcp/src/event-store/schemas.ts` — new shared-stem `worktree.create.requested`/`worktree.create.executed` pair + `launch.executing_started`/`launch.executed`; `worktree.created` **untouched** (task-scoped).
- `servers/exarchos-mcp/src/verbs/worktree/projections/worktrees.ts` — extend the `worktrees@v1` reducer `switch` to fold `launch.*` (the `worktree.create.*` pair stays a reducer **no-op**, audit-only like `worktree.remove.requested` — do not fold it, to avoid a spurious `projectionSequence` bump); `servers/exarchos-mcp/src/views/composite.ts` — surface `launch.*` in `ps`/`worktrees`.
- `servers/exarchos-mcp/src/utils/process.ts` — async cross-OS spawn.
- `runtimes/{claude,codex,cursor,copilot,opencode}.yaml` — `isolation:worktree` semantics → **launcher-managed lifecycle** (no space-enforcement claim).
- `servers/exarchos-mcp/src/adapters/cli.ts` — the verb.

### Exploration

Three 3/3-refuted adversarial rounds are the empirical record (verified against shipped code + the ADR).

- **Round 1** — refuted uniform *prevention* (needs a blocking hook or the kernel; `chdir` doesn't confine absolute paths).
- **Round 2** — refuted uniform *detection* (no write-observing hook off-Claude; a worktree-scoped watch can't see out-of-bounds writes).
- **Round 3** — refuted *pass-through-P* (Claude's hook is Write/Edit-only, Bash-bypassable, liveness-unverifiable, and Exarchos-manufactured; the launcher doesn't own nested worktree creation).
- **Resolution (chosen)** — drop space entirely; scope to the two chokepoints Exarchos owns (state + lifecycle), one shared abstraction, composing with the WLM. Hand the space-moat to #1601's fork.

### Alternatives considered

- **Launcher as a space chokepoint (rev. 0/1/2)** — refuted 3/3; a local launcher owns neither the write path nor nested worktree creation.
- **Delete `adopt`/`reconcile`, own all worktree creation** — false: harnesses create their own subagent worktrees; tracking-via-adopt is the correct (and sufficient) model.
- **Per-harness launcher implementations** — rejected: exactly the drift #1601 exists to remove (DR-4 forbids it).
- **Fold lifecycle into the WLM instead of a new CLI entry** — rejected: process supervision needs a process owner; the stdio MCP surface can't own a child's lifecycle. The launcher *produces for* the WLM.

### Open Questions

- **OQ-1 (mechanism) — RESOLVED:** lifecycle + state production, one shared abstraction; filesystem-write enforcement is a non-goal.
- **OQ-2 (scope) — RESOLVED:** all five Tier-1 in v1, no fast-follow.
- **OQ-3 (injection content/format) — deferred to #1485;** this slice ships the authority-bounded seam (DR-7).
- **OQ-4 (#1601 space-moat fork) — HANDED UP:** upstream Bash-covering hook standard vs remote/basileus kernel sandbox. Not this slice.

## Decomposition

Verification depth scales with blast radius; test-after by adequacy.

### Scope

**Target:** Full design — DR-1…DR-8, all five Tier-1, lifecycle + state + WLM-composition, one shared abstraction.
**Excluded (non-goals):** filesystem-write confinement / space tiers / boundary hooks; owning nested subagent worktree creation (WLM `adopt`); deleting `adopt`/`reconcile`/#1568; the `generic` runtime.

### Traceability matrix (DR-N → tasks)

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | Launcher verb + single lifecycle abstraction | 002, 004, 010, 014, 015 |
| DR-2 | Worktree lifecycle state (create split + ownership + liveness) | 001, 005, 006 |
| DR-3 | Compose with the WLM (produce; keep adopt; serialize merges) | 007, 014 |
| DR-4 | One shared abstraction — no per-platform fan-out | 002, 003, 008 |
| DR-5 | Sibling topology on the creation path | 005, 009 |
| DR-6 | Own the full lifecycle (signals/teardown/recovery/reconcile) | 010, 011, 012, 016 |
| DR-7 | Authority-bounded ephemeral injection seam | 013 |
| DR-8 | Cross-OS portability + Windows lane | 003, 015 |

### Tasks

Expected test names follow `Method_Scenario_Outcome`.

#### Task 001: Event schema — shared-stem create pair + launch liveness (task-less, on the `worktrees` stream)
**Risk Tier:** medium · **Implements:** DR-2
Add **4** new types to the closed union + data schemas + emission registry: `worktree.create.requested` (INV-13 intent) → `worktree.create.executed` (INV-13 **terminal**, shared stem — do NOT reuse the task-scoped `worktree.created`), `launch.executing_started`, `launch.executed`. `launch.executing_started`'s data schema carries `worktreeId` + `holderPid`/`holderStartedAt` (mirror `InFlightMerge`) so Task 016's dead-holder reconciler is expressible; all four are classified **`auto`** in `EVENT_EMISSION_REGISTRY`. Bump the count-pin **139 → 143** at **all three** `toHaveLength` sites (two in `event-store/schemas.test.ts` — incl. renaming the `EventTypes_CountIs139_*` assertion — and one in `__tests__/event-store/schemas.test.ts`). Add a doc-comment noting `worktree.created` is the **task**-worktree terminal (unchanged) and `worktree.create.*` is the **launcher** top-level pair.
**Verification:** medium — scoped tests + kill-probe.
**Files:** `servers/exarchos-mcp/src/event-store/schemas.ts`, `.../schemas.test.ts`, `.../__tests__/event-store/schemas.test.ts`
**Expected tests:** `EventTypes_IncludesCreatePairAndLaunch`, `EventTypes_CountPins_143_AllThreeSites`, `EventTypes_WorktreeCreated_Untouched`, `LaunchExecutingStarted_CarriesWorktreeIdAndHolderPid`, `EmissionRegistry_FourNewTypes_ClassifiedAuto`
**Dependencies:** None · **Parallelizable:** Yes

#### Task 002: Harness registry — declarative spawn descriptors + enum→runtime-id map
**Risk Tier:** medium · **Implements:** DR-1, DR-4
Five **declarative** descriptors + enum→runtime-id (`claude-code`→`claude`). The descriptor is a **pure-data type** — `command: string`, `args: readonly string[]`, `cwd: string`, **`env: Record<string, string>`** (string values only — NOT `unknown`, which would admit function values) — with **no function-typed fields / behavior hooks**. The pure-data property is enforced by a **compile-time** assertion (a `satisfies` / conditional-type check that fails `tsc`/`typecheck` if any field's type is or contains a function), so it is a real build gate — not a runtime value-sample that a future function-valued field with a data default could slip past.
**Verification:** medium — scoped tests + kill-probe.
**Files:** `servers/exarchos-mcp/src/launcher/harness-registry.ts`, `.../harness-registry.test.ts`, `.../harness-registry.type-test.ts`
**Expected tests:** `Registry_FiveTier1_ResolveDescriptor`, `Registry_EnumMapsRuntimeId`, `Registry_DescriptorPureData_CompileTimeAssertion`, `Registry_Unknown_StructuredError`
**Dependencies:** None · **Parallelizable:** Yes

#### Task 003: Cross-OS async spawn primitive (one interface)
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-4, DR-8
One async long-lived spawn interface over win32 `.cmd`/`.ps1` shim resolution + POSIX for harness CLIs; no shell-injection. **Tests authored OS-native** (real backslash/8.3/shim behavior), not POSIX-literal mocks — they are the win32-fragile tests the DR-8 Windows lane gates on.
**Verification:** high — scoped tests + kill-probe + integration.
**Files:** `servers/exarchos-mcp/src/utils/process.ts`, `.../utils/process.spawn.test.ts`
**Expected tests:** `AsyncSpawn_HarnessCli_LongLived`, `AsyncSpawn_Win32Shim_ResolvedNoShell`, `AsyncSpawn_MetacharArg_PassedLiterally_NoShellInterpolation`, `AsyncSpawn_Unknown_StructuredError`
**Dependencies:** None · **Parallelizable:** Yes

#### Task 004: `exarchos <harness>` verb — schema + CLI adapter + `--dry-run`
**Risk Tier:** medium · **Implements:** DR-1
Zod verb schema (enum, `--feature`, `--dry-run`), CLI registration, dry-run output (derived path + event plan, **no enforcement claim**).
**Verification:** medium — scoped tests + kill-probe.
**Files:** `servers/exarchos-mcp/src/launcher/verb.ts`, `servers/exarchos-mcp/src/adapters/cli.ts`, `.../verb.test.ts`
**Expected tests:** `Verb_Schema_ConstrainsEnum`, `Verb_DryRun_ShowsPathAndPlanNoSpawn`, `Verb_DryRun_NoEnforcementClaimInOutput`, `Verb_DryRun_DerivesPathViaSameGuardAsCreation`, `Verb_Unknown_ReturnsValidTargets`
**Dependencies:** 002, 009 · **Parallelizable:** No

#### Task 005: Worktree creation — reserve → `create.requested` → `git worktree add` → `create.executed`
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-2, DR-5
Ordered creation, **all appends on the singleton `worktrees` stream**: `reserve` (tracked) **before** `git worktree add`; `worktree.create.requested` intent → add → `worktree.create.executed` terminal (`<eventType>:<operationId>` idempotency key; crash-precheck: worktree on disk? emit terminal / skip : re-run add); **calls the DR-5 guard before add**; all git via the manager's runner. Does **not** emit `worktree.created` (task-scoped — see the DR-2 correction).
**Verification:** high — scoped tests + kill-probe + integration (real-SQLite).
**Files:** `servers/exarchos-mcp/src/launcher/create-worktree.ts`, `.../create-worktree.test.ts`
**Expected tests:** `Create_ReserveBeforeGitAdd_NoUntrackedWindow`, `Create_RequestedThenCreateExecuted_Terminal`, `Create_AppendsPairOnWorktreesStream_CorrelatedByOperationId`, `Create_CrashBetween_PrecheckResumesOrSkips`, `Create_CallsGuardBeforeAdd`, `Create_ConcurrentSameFeature_Siblings`, `Create_AllGitViaManagerRunner`, `Create_DoesNotEmitWorktreeCreated`
**Dependencies:** 001, 002, 009 · **Parallelizable:** No

#### Task 006: Launch liveness emission + `ps`/`worktrees` projection wiring
**Risk Tier:** high · **Implements:** DR-2
Emit `launch.executing_started`/`launch.executed`; **extend the `worktrees@v1` reducer `switch`** (`verbs/worktree/projections/worktrees.ts` — today `launch.*` fall through its `default → identity` arm) to fold them onto the launcher worktree entry (keyed by `worktreeId`), and surface them in the `ps` view (`views/composite.ts`). Expose the terminal-emit as an **idempotent** seam (`emitLaunchExecuted(operationId)` — at-most-once per launch even if both a signal and teardown fire) that the lifecycle/teardown/signal paths (010/011/012) call on **every catchable exit** (the guaranteed-terminal contract; phantom reconciliation of uncatchable death is Task 016). The "emitted on every catchable path" + idempotency guarantees are asserted by the **callers'** tests (011/012), not only here.
**Verification:** high — scoped tests + kill-probe + integration (view projection).
**Files:** `servers/exarchos-mcp/src/launcher/liveness.ts`, `servers/exarchos-mcp/src/verbs/worktree/projections/worktrees.ts`, `servers/exarchos-mcp/src/views/composite.ts`, `.../liveness.test.ts`, `.../projections/worktrees.test.ts`
**Expected tests:** `Liveness_EmitsStartedAndExecuted`, `Liveness_TerminalSeam_Idempotent` (in `liveness.test.ts`); `PsProjection_FoldsLaunch_ReflectsInFlight`, `PsProjection_LaunchExecuted_ClearsInFlight` (co-located in `projections/worktrees.test.ts`, asserting both fold directions — started ⇒ in-flight, executed ⇒ cleared, so a permanent phantom cannot survive)
**Dependencies:** 001, 005 · **Parallelizable:** No

#### Task 007: WLM composition — producer wiring + retain adopt/reconcile + serialize merges
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-3
Wire the launcher as a producer the `worktrees@v1` projection consumes; route integration merges through shipped `serialize_merge`; **assert `adopt`/`reconcile` remains reachable** for a harness-created nested worktree.
**Verification:** high — scoped tests + kill-probe + integration across the WLM seam.
**Files:** `servers/exarchos-mcp/src/launcher/wlm-compose.ts`, `.../wlm-compose.test.ts`
**Expected tests:** `Compose_LauncherEvents_FoldedByWorktreesProjection`, `Compose_HarnessCreatedWorktree_TrackedViaAdopt`, `Compose_LauncherCreatedWorktree_NotReAdopted`, `Compose_IntegrationMerge_RoutesThroughSerializeMerge`
**Dependencies:** 005 · **Parallelizable:** No

#### Task 008: Single-abstraction guard — pure-data descriptor + no per-harness branching
**Risk Tier:** medium · **Implements:** DR-4
The **load-bearing** guarantee is the Task-002 compile-time pure-data descriptor type-pin (which — via Task 014 typing every on-ramp output as `HarnessDescriptor` — reaches the on-ramp files too). This task adds the complementary **structural** guard as the backstop, scanning the **whole lifecycle surface**, not just the core: `lifecycle-core.ts`/`runLifecycle` (Task 010) **and** the sibling lifecycle files (`signals.ts`, `teardown.ts`, `liveness.ts`, `create-worktree.ts`, `injection-seam.ts`, `harnesses/*.ts`) for `switch (harness)` / `if harness === 'x'` and the naive literal harness-keyed behavior map (a five-harness-keyed object of functions / a `Record<Harness, Fn>` annotation). Scope-honesty: a structural scan cannot catch every dynamically-built, cross-module, or runtime-id-keyed table — those are covered only by the type-pin, which is why the pin is load-bearing and this scan is the backstop. Depends on 010 **and 014** so it guards the real core **and** the real on-ramps, not stubs.
**Verification:** medium — scoped structural test + kill-probe.
**Files:** `servers/exarchos-mcp/src/launcher/single-abstraction.guard.test.ts`
**Expected tests:** `LifecycleSurface_NoHarnessNameBranching`, `LifecycleSurface_NoLiteralHarnessKeyedBehaviorMap`, `Descriptor_TypeLevel_PureData`
**Dependencies:** 002, 010, 014 · **Parallelizable:** No

#### Task 009: Sibling worktree path derivation + nesting guard (pure, cross-OS)
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-5
A pure `deriveWorktreePath` (sibling-off-base) + nesting/containment guard, consumed by both `--dry-run` (004) and creation (005). Path logic is `path.join`/`toPosix`-built and symlink-resolved; **tests authored OS-native** (real backslash/8.3/symlink), not POSIX-literal — a DR-8 win32-fragile surface the Windows lane gates on. (Re-tiered from medium: this is cross-OS containment, not a trivial pure function.)
**Verification:** high — scoped tests + kill-probe + integration (cross-OS path).
**Files:** `servers/exarchos-mcp/src/launcher/topology.ts`, `.../topology.test.ts`
**Expected tests:** `Derive_SiblingOffBase_Path`, `Guard_NestedTarget_Refused`, `Derive_Win32Path_ContainmentHolds`
**Dependencies:** None · **Parallelizable:** Yes

#### Task 010: Launcher lifecycle orchestration — spawn→place→observe→teardown + real verb binding
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-1, DR-6
Integrate spawn (003) + creation (005) + liveness (006) + WLM produce (007) into the harness-agnostic core; **wire the non-dry-run verb to actually invoke this and spawn**; **place** the child in the created worktree (`chdir`); teardown-once.
**Verification:** high — scoped tests + kill-probe + integration across spawn→teardown.
**Files:** `servers/exarchos-mcp/src/launcher/lifecycle-core.ts`, `servers/exarchos-mcp/src/launcher/verb.ts`, `.../lifecycle.test.ts`
**Expected tests:** `Lifecycle_TeardownExactlyOnce`, `Lifecycle_NoHandleOutlivesChild`, `Lifecycle_PlacesChildInWorktree_CwdEqualsWorktree`, `Verb_NonDryRun_InvokesLifecycleAndSpawns`
**Dependencies:** 003, 004, 005, 006, 007 · **Parallelizable:** No (integrator)

#### Task 011: Signal handling + orphan prevention
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-6
Trap+forward `SIGINT`/`SIGTERM`; teardown on parent interruption; no orphaned/detached child if the launcher dies. On the signal path, the guaranteed `launch.executed` terminal is emitted via the Task-006 idempotent seam — asserted here (the DR-6 "every catchable exit" contract), not deferred to the Task-016 uncatchable-death reconciler.
**Verification:** high — scoped tests + kill-probe + integration (signal/death races).
**Files:** `servers/exarchos-mcp/src/launcher/signals.ts`, `.../signals.test.ts`
**Expected tests:** `Signals_SigtermForwarded_ThenTeardown`, `Signals_SigtermPath_EmitsLaunchExecutedTerminal`, `Signals_LauncherDies_ChildNotOrphaned`, `Signals_DoubleSignal_TeardownIdempotent`
**Dependencies:** 010 · **Parallelizable:** No

#### Task 012: Teardown safety + recovery/crash/cwd-drift/origin edges
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-6
Never `reset --hard`; preserve uncommitted; `recoveryError`; crash-mid-spawn recovery; cwd-drift ancestry exclusion; origin-unreachable fail-closed. The normal-exit + teardown paths emit the guaranteed `launch.executed` terminal via the Task-006 idempotent seam — asserted on **every** catchable teardown path (the DR-6 contract), and idempotent when a signal (011) already fired it.
**Verification:** high — scoped tests + kill-probe + integration.
**Files:** `servers/exarchos-mcp/src/launcher/teardown.ts`, `.../teardown.test.ts`
**Expected tests:** `Teardown_NeverResetHard_PreservesUncommitted`, `Teardown_UncleanRelease_RecoveryError`, `Teardown_EveryCatchablePath_EmitsLaunchExecuted`, `Recovery_CrashMidSpawn_NoOrphanWorktree`, `Recovery_CwdDriftSelfAncestry_Excluded`, `Recovery_OriginUnreachable_FailsClosed`
**Dependencies:** 010 · **Parallelizable:** No

#### Task 013: Authority-bounded ephemeral orientation-injection seam
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-7
Env/transient-prompt injection at spawn, no repo write; typed interface that **tags** the payload as non-authoritative `orientation` (distinct from any directive channel). Asserts the tag/placement — **not** runtime precedence over the model (which the launcher cannot own).
**Verification:** high — scoped tests + kill-probe.
**Files:** `servers/exarchos-mcp/src/launcher/injection-seam.ts`, `.../injection-seam.test.ts`
**Expected tests:** `Injection_Payload_NoRepoWrite`, `Injection_TaggedNonAuthoritativeOrientation`, `Injection_Absent_LaunchUnchanged`
**Dependencies:** 010 · **Parallelizable:** No

#### Task 014: Per-harness on-ramps (5) + `runtimes/*.yaml` lifecycle semantics
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-1, DR-3
Thin declarative on-ramps for the five harnesses; **each on-ramp's output is typed as `HarnessDescriptor`**, so it inherits Task 002's compile-time pure-data pin (no behavior can hide in an on-ramp — the guard surface's type half). Shift all five `runtimes/*.yaml` `isolation:worktree` semantics to **launcher-managed lifecycle** (drop the space-enforcement framing — no P/S/N, no native/advisory-as-enforcement); re-render skills, pass `skills:guard`.
**Verification:** high — scoped tests + kill-probe + `build:skills`/`skills:guard` clean.
**Files:** `servers/exarchos-mcp/src/launcher/harnesses/*.ts`, `runtimes/{claude,codex,cursor,copilot,opencode}.yaml`, `.../on-ramps.test.ts`
**Expected tests:** `OnRamp_EachTier1_DeclarativeDescriptor`, `Runtimes_IsolationSemantics_LauncherManagedLifecycle`, `Runtimes_NoSpaceEnforcementClaim`
**Dependencies:** 004, 007, 010 · **Parallelizable:** No

#### Task 015: Verb conformance + INV-5 + Windows CI lane (named, required)
**Risk Tier:** high · **Implements:** DR-1, DR-8
Verb registration with schema constraints + "do NOT use for"; visible-tool-count unchanged; a **required** Windows CI lane running the named win32-fragile tests (async spawn shim `003`, path derivation/containment `009`), authored OS-native. `WindowsLane_RunsNamedSpawnAndPathTests_Required` asserts `.github/workflows/ci.yml` **wires the lane and names those tests**; the "required/blocking" gating itself is a GitHub **branch-protection** setting (out-of-repo, not vitest-assertable) — called out in the PR/repo-settings checklist so "lane present but non-blocking" cannot silently pass as done.
**Verification:** high — scoped tests + kill-probe + CI-lane wiring.
**Files:** `servers/exarchos-mcp/src/launcher/verb.ts`, `servers/exarchos-mcp/src/registry.test.ts`, `.github/workflows/ci.yml`
**Expected tests:** `Verb_SchemaConstraints_Present`, `Verb_WhenNotToUse_Present`, `VisibleToolCount_Unchanged`, `WindowsLane_RunsNamedSpawnAndPathTests_Required`
**Dependencies:** 004, 010 · **Parallelizable:** No

#### Task 016: Phantom-launch reconciler — on-demand probe extension for uncatchable death
**Risk Tier:** high · **Implements:** DR-6
Extend the shipped #1577 on-demand ground-truth probe to reconcile `launch.*`: a `launch.executing_started` with no paired `launch.executed` whose holder PID is provably dead (protected-ancestry probe) is reconciled to a terminal, so a `SIGKILL`/host-death never folds a permanent phantom in-flight launch in `ps`. On-demand only (GC / `ps --probe`), no polling (INV-10/15).
**Verification:** high — scoped tests + kill-probe + integration (probe seam).
**Files:** `servers/exarchos-mcp/src/verbs/worktree/pure/probe.ts`, `servers/exarchos-mcp/src/launcher/launch-reconcile.ts`, `.../launch-reconcile.test.ts`
**Expected tests:** `Reconcile_DeadHolderStartedNoExecuted_EmitsTerminal`, `Reconcile_LiveHolder_LeftInFlight`, `Reconcile_OnDemandOnly_NoPolling`
**Dependencies:** 006, 010 · **Parallelizable:** No

### Parallelization

- **Wave 1 (no deps):** 001, 002, 003, 009
- **Wave 2:** 004 (←002,009), 005 (←001,002,009)
- **Wave 3:** 006 (←001,005), 007 (←005)
- **Wave 4 (integrator):** 010 (←003,004,005,006,007)
- **Wave 5:** 011 (←010), 012 (←010), 013 (←010), 016 (←006,010), 014 (←004,007,010), 015 (←004,010)
- **Wave 6:** 008 (←002,010,014) — runs last so the guard scans the real core **and** the real on-ramps

**Critical path:** 001 → 005 → 007 → 010 → 014 → 008. (008 now also depends on 014 so its structural guard scans the real on-ramps, not stubs; 016 reconciles launch liveness after the integrator.)

### Completion checklist

- [x] Every DR-N (DR-1…DR-8) maps to ≥1 task; the matrix is a **faithful inverse** of the task `Implements:` stamps (each task appears under every DR it stamps)
- [x] Every task carries a `riskTier`; boundary-touching integration/injection tasks are `high`
- [x] Space enforcement is fully removed (non-goal); no boundary hooks, no P/S/N tiers, no `adopt`/`reconcile` deletion
- [x] Substrate-honest: the launcher worktree is a task-less top-level kind tracked via `worktree.reserved` + `launch.*` (the events `worktrees@v1` actually folds), NOT the task-scoped `worktree.created` (which requires `taskId` and is unfolded by `worktrees@v1`); creation is `reserve`-before-add + a **shared-stem** `worktree.create.requested`→`worktree.create.executed` INV-13 pair on the singleton `worktrees` stream (no split-brain vocabulary; one-stream crash-precheck by `operationId`); `launch.executing_started` (carries `worktreeId`+`holderPid`)/`launch.executed` follow the INV-10 pattern; count-pin 139→143 across all three assertion sites; state chokepoint named as the append substrate
- [x] Adopt-race closed (reserve-before-add ordering); create-vs-adopt boundary pinned by a no-re-adopt test (Task 007)
- [x] One shared abstraction: **compile-time pure-data descriptor** assertion (load-bearing; `env: Record<string,string>`, fails `tsc`; on-ramp outputs typed `HarnessDescriptor` so they inherit it — Task 014) + structural anti-branch guard (backstop) covering `switch`/`if` **and** literal harness-keyed behavior maps across the **whole lifecycle surface incl. on-ramps** (Task 008←010,014); one cross-OS spawn primitive; required Windows lane over OS-native-authored tests (003/009)
- [x] Phantom-launch reconciler for uncatchable death (Task 016); guaranteed `launch.executed` on **every catchable** path via the idempotent 006 seam, **asserted** by the callers' tests (011 `Signals_SigtermPath_EmitsLaunchExecutedTerminal`, 012 `Teardown_EveryCatchablePath_EmitsLaunchExecuted`), not only the 006 happy path
- [x] Real verb→lifecycle spawn binding owned+tested (Task 010); topology guard on the creation path (005←009); injection seam down-scoped to *declares* non-authoritative (Task 013, no manufactured precedence guarantee)
- [x] Open questions resolved or handed up (OQ-3 → #1485, OQ-4 → #1601 fork)
- [x] Ready for `plan-review` (rev. 4 — fresh independent panel HIGH gaps fixed: **H1** dropped the `worktree.created` reuse [task-less launch tracked via `worktree.reserved` + `launch.*`, the events `worktrees@v1` actually folds], **H2** guaranteed-terminal tests added to 011/012, **H3** Task-008 duplicate dependency line removed; + 6 MEDIUMs: stream-family + split-brain vocab unified on the `worktrees` stream via a shared-stem create pair, compile-time type-pin, behavior-map guard, place-step test, dry-run negative test, `holderPid` on `launch.executing_started`)
