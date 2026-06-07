# Design: Onboarding Consolidation — `onboard` + `doctor` (plan-ready)

**Status:** Design (plan-ready) — supersedes the spike with the §9 open questions resolved
**Date:** 2026-06-06
**Milestone:** v2.10.2 (onboarding consolidation)
**Epic:** [#1510](https://github.com/lvlup-sw/exarchos/issues/1510)
**Spike (exploration record):** [`docs/designs/2026-05-31-onboard-doctor-consolidation.md`](2026-05-31-onboard-doctor-consolidation.md)
**Depends on:** Universal layered toolchain resolver — Bundle B (#1508 + #1507), **landed** (PR #1511 merged; both issues closed)

---

## Problem Statement

Since v2.10.0 the *configuration* surface grew sharply (toolchains, invariants catalogs,
quality hints, handoff lint) and the v2.10.1 layered toolchain resolver (Bundle B) grew it
again. Meanwhile the *onboarding* surface that is supposed to set all of this up fragmented
into **four** entry points with overlapping responsibility and no single "make my repo ready"
command:

| Verb / handler | Responsibility today | Overlap |
|---|---|---|
| `init` | Detect runtime + VCS; write per-runtime MCP config; seed `.exarchos.yml`; emit `init.executed` | MCP registration overlaps `install-skills` |
| `install-skills` | Install skills bundle to `~/.claude/skills/`; then `registerExarchosInClaudeJson()` | Same MCP-registration write `init` does |
| `doctor` | 11 read-only checks; emit `diagnostic.executed`; **report-only, never fixes** | Diagnoses what `init`/`install-skills` produce, can't repair |
| `new-project` | Scaffold a fresh repo; `applyLanguageCustomizations` does an npm→dotnet **string-rewrite** (#1508 residue) | Parallel code path generating the same artifacts as `init` |

Consequences: no holistic entry point (onboarding is a *sequence*, not a command);
duplicated writers (MCP registration written twice; `.exarchos.yml` generated twice);
diagnosis without repair (`doctor` enumerates 11 failure modes, fixes none); and an
INV-6-violating npm-as-canonical string-rewrite that the layered resolver makes unnecessary.
The richer the configuration, the more valuable a single command that derives and reconciles
all of it.

## Chosen Approach

Collapse the four entry points into **two holistic verbs over one shared reconciler** —
the spike's Decision D (INV-2 facade-equivalence):

```
core/onboarding/reconcile.ts   (pure, harness-neutral)
  detectDesiredState(repoRoot, opts) → DesiredState     // leans on Bundle B resolver
  diff(desired, actualProbes)        → ReconcilePlan     // = doctor's 11 checks, structured
  apply(plan, ctx)                   → ReconcileResult    // composes init writers + skills install

consumers (thin — zero behavior, presentation only):
  onboard      → detect → diff → apply(full) → verify(diff)
  doctor       → detect → diff → report                       (read-only)
  doctor --fix → detect → diff → apply(diff) → re-diff → report
```

`onboard` brings a repo (existing **or** greenfield via `--new`) to a fully-configured,
skills-installed, MCP-registered, hooks-bound, green-`doctor` state in one idempotent command.
`doctor` diagnoses that same desired state; `doctor --fix` repairs it by calling the **same
`apply`** `onboard` uses. The load-bearing move: today's `doctor` emits fix-*hint strings
nobody consumes — promoting them to a structured `ReconcilePlan` that `apply` executes is what
lets one engine serve both verbs.

**Locked top forks (from the spike):** Decision A — hard replace (`init`/`install-skills`
removed); Decision B — fold `new-project` into `onboard --new`; Decision C — runtime
resolution never gen-time (INV-4); Decision E — idempotent + non-destructive by default.

### Resolved open questions (§9 of the spike)

| Q | Decision | Rationale |
|---|---|---|
| **Q4 — Event contract** | **`onboard.requested` + `onboard.executed`** (INV-13 two-event split) | `onboard` performs non-idempotent external side effects (writes `~/.claude.json`, shells `npx`); the split makes a crash between intent and result recoverable via an idempotent re-diff precheck. Retires `init.executed`. |
| **Q1 — Install parity** | **CLI-only; MCP returns a structured advisory** | Skills+deps install shells `npx` and writes `~/.claude/`; the server arm can't honor it portably (and breaks for remote-MCP, INV-3). Steps 1–3+5 stay parity-able. |
| **Q3 — Hook install** | **Default on** (`--no-hooks` opt-out) | The #1485 SessionStart binding is part of "ready"; installing it by default delivers the strongest fully-wired outcome. Idempotent; `doctor` diff covers it so `--fix` can repair it. |
| **Q2 — Interactivity** | **Non-interactive now; `--interactive` rides #1087** | Agent-first ⇒ flags-first. Building throwaway prompt infra ahead of the v3.0 `IInteractionService` is wasted work. |
| Q5 — Semver | Patch (verb-removing break flagged in release notes; one-release error stubs) | Owner call, already chosen. |
| Q6 — `onboard ⊇ doctor`? | Keep `doctor` as its own verb | Read-only diagnosis is a distinct intent; preserves the two-verb goal. |

## Approaches Considered

The design space was explored in the spike; the genuine top-level fork was the *shape* of the
consolidation, and the four §9 decision gates resolved the residual forks. Recorded here for
provenance.

### Option 1: Hard replace over one reconciler (CHOSEN)

**Approach:** Remove `init`/`install-skills`/`new-project` outright; extract one pure
`detect → diff → apply` reconciler that `onboard`, `doctor`, and `doctor --fix` consume as thin
facades. One-release error stubs cover the removed verbs.

**Pros:** Single writer for config/MCP/skills (no duplication); `doctor --fix` and `onboard`
converge by construction; closes the #1508 string-rewrite; cleanest INV-2 story.
**Cons:** A verb-removing break in a patch line; requires the characterization baseline (DR-9) to
land first to guard the fold.
**Best when:** The duplication and the diagnose-but-never-repair gap are the actual pain — which
they are.

### Option 2: Compose + deprecate (keep `init`/`install-skills` as deprecated aliases)

**Approach:** Build `onboard`/`doctor --fix` over the reconciler but keep the old verbs as
warning-emitting aliases that delegate to the new core for one or more releases.

**Pros:** Zero hard break; gentler migration. **Cons:** The duplicated *surface* lingers even
though the *writers* are deduped; "how do I get started" stays a three-answer question; carries
dead verbs into v3.0. **Best when:** A hard break is unacceptable — but Decision A judged the
break acceptable with error stubs.

### Option 3: Keep four verbs, only dedupe the writers

**Approach:** Leave the CLI surface as-is; refactor the shared MCP-registration / config-seed
writers behind the scenes so `init`/`install-skills`/`new-project` stop duplicating logic.

**Pros:** Smallest change; no migration. **Cons:** Solves duplication but **not** the holistic-entry
goal (still no single "make my repo ready" command) and **not** the diagnose-without-repair gap;
the onboarding sequence stays a sequence. **Best when:** The only problem were the duplicate
writers — but the missing holistic verb and `doctor`'s impotence are co-equal problems.

**Recommendation:** Option 1. It is the only option that delivers *all three* goals (holistic
entry point, repair-capable `doctor`, zero duplication) and the strongest INV-2/INV-6 posture; the
one real cost (a patch-line break) is bounded by the error stubs (DR-5) and the characterization
guard (DR-9).

## Requirements

### DR-1: Shared reconciler core (INV-2 facade)

Extract a pure, harness-neutral reconciler at `servers/exarchos-mcp/src/core/onboarding/reconcile.ts`
exposing `detectDesiredState`, `diff`, and `apply`. It consumes the Bundle B layered resolver
for all command derivation (override > `.exarchos.yml` > user `toolchains:` > task-runner >
registry) — never a string-rewrite. Each step in a `ReconcilePlan` carries a `surface`
capability tag so the executor can gate CLI-only steps (DR-6). *Implements epic T1.*

**Acceptance criteria:**
- `detectDesiredState`, `diff`, `apply` are pure functions with no adapter imports; behavior
  lives only here (a grep of `adapters/cli.ts` / `adapters/mcp.ts` for onboarding logic returns
  only presentation/formatting — INV-2 audit).
- Command fields in `DesiredState` (`test`/`typecheck`/`install`) are produced by the layered
  resolver; no `applyLanguageCustomizations`-style transform exists in the path (INV-6).
- `diff(desired, actual)` returns the same structured findings the 11 `doctor` checks produce
  (DR-4 consumes this); `apply(plan)` is a no-op when `plan` is empty (idempotence).

### DR-2: `onboard` verb — adopt an existing repo

```
exarchos onboard [--new <name>] [--runtime <id>…] [--vcs <id>]
                 [--dry-run] [--force] [--no-hooks] [--format table|json]
```

Pipeline: **DETECT** (toolchain/runtime/VCS/agent-host) → **CONFIG** (reconcile `.exarchos.yml`
+ `.exarchos/` + invariants catalog when `devCatalog`; derive from resolver; never overwrite
hand edits unless `--force`) → **GENERATE** (per-runtime artifacts via existing `init` writers
+ hooks per DR-8) → **INSTALL** (skills bundle + project deps; CLI-only per DR-6) →
**VERIFY** (run `doctor`'s diff in-process; exit non-zero on residual blocking Fail).
Idempotent; each step reconciles, never blind-writes. *Implements epic T2.*

**Acceptance criteria:**
- Given a fresh clone, When `exarchos onboard` runs, Then the repo ends fully-configured +
  skills-installed + MCP-registered + hooks-bound + `doctor` green, in one command.
- Given an already-onboarded repo, When `onboard` re-runs, Then it reconciles drift only and
  leaves hand-edited `.exarchos.yml` keys untouched (no `--force`).
- `--dry-run` prints the `ReconcilePlan` and writes nothing; `--format json` emits the plan/result
  as structured output (INV-5b carrier shape with `next_actions`/`_meta`/`_perf`).

### DR-3: `onboard --new <name>` greenfield + retire `new-project`

`--new <name>` is the *only* difference between greenfield and adopt: create the directory,
seed the salvageable initial scaffold (dir + `.exarchos.yml` seed + `.gitignore`), then run the
identical DR-2 1–5 pipeline. **Retire the internal `new-project` handler and delete
`applyLanguageCustomizations`** (closes #1508; INV-6 — commands come from the resolver, not an
npm-rewrite). *Implements epic T3.*

**Acceptance criteria:**
- `onboard --new foo` produces a repo byte-identical (modulo timestamps) to `onboard` run inside
  an equivalently-seeded empty repo — one scaffolding code path, not two.
- `applyLanguageCustomizations` and the `new_project` orchestrate action no longer exist;
  no `npm run …` string-rewrite remains in the onboarding path.
- Given `--new foo` where `foo/` exists and is non-empty, Then `onboard` refuses with a clear
  error (no partial scaffold over existing files).

### DR-4: `doctor --fix` over the shared `apply` (INV-5b)

Promote `doctor`'s 11 checks from emitting fix-*hint strings* to producing a structured
`ReconcilePlan` (= the reconciler `diff`). Bare `doctor` stays read-only diagnosis. `doctor --fix`
calls the **same `apply`** `onboard` step 2–4 calls, re-runs the diff, and reports residuals.
*Implements epic T4.*

**Acceptance criteria:**
- Every `doctor` check that today carries a `fix` hint string instead contributes a structured
  plan step that `apply` can execute (no orphan hint strings).
- Given a repo with reconcilable drift, When `doctor --fix` runs, Then the post-fix re-diff shows
  the repaired checks passing and `onboard` (on the same repo) would now be a no-op — the two paths
  converge by construction.
- Bare `doctor` (no `--fix`) writes nothing and emits `diagnostic.executed` only (read-only intent).

### DR-5: Remove `init` / `install-skills`; one-release error stubs

Delete the `init` and `install-skills` CLI verbs and the `exarchos_orchestrate.init` action
(replaced by an `onboard` action). Dedupe the MCP-registration writer (today written by both
`init` and `install-skills`) into the single reconciler. Add one-release **error stubs**:
`init` / `install-skills` print `renamed → use 'exarchos onboard'` and exit non-zero (not "command
not found"); removed entirely at v3.0. *Implements epic T5.*

**Acceptance criteria:**
- `init` and `install-skills` invocations exit non-zero with the rename message; no onboarding side
  effect runs from the stub.
- MCP-registration is written by exactly one code path (the reconciler `apply`); no duplicate writer
  remains (grep for the two former call sites returns the stub + the reconciler only).
- `exarchos_orchestrate` exposes an `onboard` action and no `init` action; visible composite tool
  count stays at 4 (INV-5d).

### DR-6: CLI/MCP parity split — install is CLI-only with MCP advisory (INV-2/INV-3)

Split the reconciler so steps 1–3 + 5 (detect/config/generate/verify) are MCP-parity-able and
step 4 (skills+deps install, which shells `npx` and writes `~/.claude/`) is gated by the
`DispatchContext` surface capability, not by adapter branching. The MCP `onboard` action runs
1–3+5 and returns a **structured advisory** for step 4 (e.g. `installStep: { surface: "cli-only",
advisory, commands }`) — never a silent success. *Implements epic T6.*

**Acceptance criteria:**
- The parity harness (`init.parity.test.ts` successor) proves CLI and MCP produce identical
  `ToolResult`s for steps 1–3+5 given the same `DispatchContext` + args (INV-2).
- Given the MCP `onboard` action, When invoked, Then step 4 is skipped and the result carries a
  structured `installStep` advisory with `next_actions` pointing to the CLI (INV-5b/INV-12) —
  not an error, not a silent no-op.
- The step-4 gate is a property of the plan's `surface` tag + context capability, not an
  `if (adapter === 'mcp')` branch in an adapter file.

### DR-7: Event contract — `onboard.requested` + `onboard.executed` (INV-1 / INV-13)

The reconciler `apply` emits a two-event split: `onboard.requested` (intent + full
`ReconcilePlan` payload) **before** side effects, `onboard.executed` (result) **after**. Both
carry a `trigger` discriminator (`onboard` | `onboard-new` | `doctor-fix`) and an idempotency key
(INV-8). On retry the `requested` event idempotency-collapses; on crash recovery the next
invocation observes `requested` without `executed` and runs an idempotent **re-diff precheck**
(re-detect, re-diff, apply only residual) before re-emitting. Retire `init.executed`; bare
`doctor` keeps the single read-only `diagnostic.executed`. Widen the event zod schema in
`event-store/schemas.ts` **atomically** with the parity/snapshot tests. *Implements epic T7.*

**Acceptance criteria:**
- `onboard` (and `doctor --fix`) emit exactly `onboard.requested` then `onboard.executed`; a dry-run
  emits neither.
- Given an `onboard.requested` with no paired `onboard.executed` (simulated crash), When `onboard`
  re-runs, Then it applies only the residual diff and emits one `onboard.executed` — no double side
  effect (INV-13 + INV-8).
- The zod schema for the two events lands in the same change as the schema/parity/snapshot tests;
  `init.executed` is removed from the schema and from any projection that read it.

### DR-8: SessionStart hook installation — default on (#1485)

The GENERATE step installs the #1485 SessionStart cross-harness binding hook **by default**.
`--no-hooks` suppresses it. Installation is idempotent (re-running `onboard` does not double-register
the hook). The `doctor` diff includes a hook-presence check so `doctor --fix` installs/repairs a
missing binding. *Contributes to T2/T4/T8.*

**Acceptance criteria:**
- Given `onboard` with no flag, Then the SessionStart binding is present after the run; given
  `--no-hooks`, Then it is absent and nothing else changes.
- Re-running `onboard` leaves exactly one hook registration (idempotent; no duplicate entries).
- `doctor` reports a missing/!corrupt SessionStart binding as a Fail/Warn; `doctor --fix` repairs it
  via the same `apply`.

### DR-9: Characterization baseline (Feathers) — guard the fold

Before any code moves, pin the current observable outputs of `init`, `doctor`, `install-skills`,
and `new-project`: files written (paths + content shape), MCP-registration shape in `~/.claude.json`,
`.exarchos.yml` seed, and emitted events. These characterization tests guard the refactor (mirrors
Bundle B's T0). *Implements epic T0 — sequenced first.*

**Acceptance criteria:**
- A characterization test suite captures each of the four entry points' current outputs and passes
  against `main` before the consolidation begins.
- The suite is the regression oracle for DR-1–DR-8: the post-fold `onboard`/`doctor` reproduce the
  union of the pinned outputs (minus the intentionally-deleted string-rewrite and duplicate writer).

### DR-10: Error handling, failure modes, and edge cases

**Acceptance criteria:**
- **Partial-apply crash (INV-13):** Given side effects interrupted mid-`apply`, When `onboard`
  re-runs, Then the re-diff precheck applies only the residual and converges — never re-applies a
  completed non-idempotent write.
- **Non-destructive default:** Given hand-edited `.exarchos.yml` keys, When `onboard`/`doctor --fix`
  run without `--force`, Then those keys are preserved (the `seedExarchosConfig` never-overwrite
  posture holds); `--force` overwrites and says so.
- **Install failure (offline / `npx` error):** Given step 4 fails, Then `onboard` exits non-zero,
  the already-applied config/generate steps are **not** rolled back (reconcile is forward-only), and
  a re-run resumes from the residual diff; the local-copy fast path is preferred when offline.
- **MCP install invocation:** Given the MCP `onboard` action, When step 4 would run, Then the result
  is a structured advisory (DR-6), never a silent success or a server-side `~/.claude/` write.
- **`--new` over existing dir:** Given `--new foo` where `foo/` is non-empty, Then refuse with a clear
  error and write nothing.
- **Unresolved toolchain:** Given DETECT cannot resolve a test/typecheck command, Then `onboard`
  warns, writes what it can, and `doctor` flags the gap (no fabricated command, no crash).
- **VERIFY residual blocking Fail:** Given a blocking check still fails after apply, Then `onboard`
  exits non-zero and prints the `doctor` diff (INV-5b error envelope with `suggestedFix`).

## Technical Design

**Reconciler types (sketch):**

```ts
type Surface = 'any' | 'cli-only';
interface PlanStep { kind: 'config'|'generate'|'install'|'hook'; surface: Surface; … }
interface ReconcilePlan { steps: PlanStep[]; }                 // = structured doctor diff
interface ReconcileResult { applied: PlanStep[]; skipped: PlanStep[]; residual: PlanStep[]; advisories: Advisory[]; }
```

**Event flow (INV-13):**

```
onboard ─▶ detect ─▶ diff ─▶ [emit onboard.requested {plan, trigger, idemKey}]
        ─▶ apply(plan, ctx) ──(side effects: writers, npx, hooks)──▶
        ─▶ [emit onboard.executed {result, idemKey}] ─▶ verify(re-diff)
crash between the two events ▶ next run: re-diff precheck ▶ apply(residual) ▶ executed
```

`apply` owns event emission (behavior in the core, INV-2). `doctor --fix` reuses the same `apply`,
so its events are `onboard.*` with `trigger: doctor-fix`. Bare `doctor` is read-only →
`diagnostic.executed` only.

## Integration Points

- **Bundle B layered resolver** (`src/config/toolchains.ts` + task-runners) — sole source for
  command derivation in DETECT/CONFIG.
- **Existing `init` writers** (`orchestrate/init/writers/{claude-code,copilot,cursor,codex,opencode,mcp-json-writer}.ts`)
  — reused verbatim by GENERATE; not rewritten.
- **`seedExarchosConfig`** — its never-overwrite posture is preserved in CONFIG.
- **Event store** (`event-store/schemas.ts`) — atomic schema widening for the two-event contract.
- **`exarchos_orchestrate`** — `init` action → `onboard` action; `doctor` action gains a `fix` arg.
- **Bootstrap scripts** (`scripts/get-exarchos.{sh,ps1}`), docs/guides, `dogfood`/`doctor`
  references, CLAUDE.md architecture note — updated in T8.

## Testing Strategy

Characterization first (DR-9 / T0). Then unit tests for `detect`/`diff`/`apply`; idempotent-re-run
test; `doctor --fix` convergence test (post-fix re-diff clean ⇒ `onboard` no-op); `onboard --new`
byte-equivalence test; crash-recovery test (requested-without-executed ⇒ residual-only apply);
MCP/CLI parity harness for steps 1–3+5 + the step-4 advisory assertion; full `npm run test:run`
(root + `servers/exarchos-mcp`); `npm run typecheck`; invariant lint (`npm run lint:invariants`,
INV-6 advisory scan) green.

## Open Questions

All §9 spike questions are resolved (table above). Remaining implementation-time detail, to settle
in `/plan`, not blockers:

- Exact `trigger` enum surface and whether `onboard-new` is a distinct trigger value or
  `onboard` + a `greenfield: true` field on `onboard.requested` (DR-7).
- Whether the step-4 `surface` gate reads an existing `DispatchContext` capability flag or
  introduces a new one (DR-6) — confirm against the INV-11/INV-3 capability model during planning.
