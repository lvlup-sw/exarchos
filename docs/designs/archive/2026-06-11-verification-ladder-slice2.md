# Verification ladder — slice 2: config-resolved policy + onboarding integration (R2 + R9)

**Date:** 2026-06-11 · **Workflow:** `verification-ladder-slice2` · **Epic:** #1515 (milestone 15, v2.11.0)
**Sub-issues:** #1517 (R2 — verification policy, config-resolved tier→gate sequences), #1524 (R9 — onboarding integration + doctor check)
**Predecessor:** `docs/designs/2026-06-09-verification-ladder-slice1.md` (PR #1535, merged)

## 1. Goal & scope

Complete Phase 1 of epic #1515. Slice 1 shipped the verification ladder's spine — the frozen
`(riskTier, boundaryTouching) → gate sequence` table in `workflow/verification-policy.ts`,
deliberately config-free, with its header documenting the contract this slice now fulfills:
*"the override layer composes ON TOP of this table, it does not replace it."* Slice 2 delivers
that override layer (R2) and plugs verification into the onboard/doctor reconciler (R9), making
this the last feature slice before the **v2.11.0-preview.1** cut.

**In scope:**

- A strict `verification:` block in `.exarchos.yml` (ProjectConfigSchema side) carrying per-cell
  gate-sequence overrides, schema-constrained to the `GateName` enum.
- `resolveVerificationPolicy` — a layered resolver (config cell > built-in cell) mirroring the
  toolchain resolver idiom; consumed by `prepare_delegation`'s stamp and `resolvePolicySkip`.
- Per-workflow severity: oneshot workflows resolve verification-gate failures to advisory.
- R9: `ResolvedCommandsSchema` grows `mutation`/`lint`; `detectDesiredState` resolves them via
  the existing `resolveVerificationRuntime`; `doctor --fix` seeds **commands only**.
- New doctor check `verification-toolchain` (`verificationToolchainResolvable`).
- T0 characterization pinning current onboard/doctor outputs before the fold.

**Out of scope (explicitly):** R5 `check_mutation_adequacy` (#1520), R6 cheap-mix planning
defaults (#1521), R10 governance (#1525), SIV-5/6/7, SIV-3 Layer B, custom (non-built-in) gate
names in sequences, per-*tier* severity (rationale §4.4), and writing verification-policy
defaults into consumer config (rationale §4.6 — the gen-time bake trap). No new MCP actions and
no new CLI verbs are added anywhere in this slice.

## 2. Constraints (invariant anchors)

Anchored to `.exarchos/invariants.md`. Always-load set probed during design: **INV-6** (the
watch-item — tier→gate *policy* stays a typed substrate module + config, never skill prose or
workflow-typed branches; the one workflow-typed fact, oneshot-advisory, is expressed as data in
the resolver, not branching prose), **INV-1** (resolution is pure over config input; gate runs
keep emitting `gate.executed`; no side state), **INV-2** (onboard and doctor stay two callers
over one reconciler core; no behavior in adapters), **INV-5a** (the `verification:` block is
schema-constrained — gate names are a `z.enum` over `VERIFICATION_GATE_NAMES`, `.strict()`
keys, duplicate-free refinement — not prose-validated), **INV-5b** (gates keep the fixed
carrier; skip results carry the policy-source discriminant), **INV-8** (gate re-runs keep
idempotency-collapsing via `operationId`; never CAS-pin follow-on events), **INV-12** (the
resolved sequence keeps riding delegation records and `next_actions`), **INV-15** (everything
local).

Pulled on domain match: **INV-4** (R9 resolves toolchains at detect-time and seeds *commands*
as explicit tier-2 config — the resolved *policy* is never baked into shipped artifacts or
consumer config), **INV-5d** (deliberate property: this slice registers zero new actions — the
composite-tool count and per-action schema surface are untouched).

## 3. Architecture — the resolved policy

```
            .exarchos.yml  verification.policy.<cell>     (override layer, optional)
                              │  cell-wise full replacement
                              ▼
   resolveVerificationPolicy(config)                      (NEW — workflow/verification-policy-resolver.ts)
                              │
                              │  fallback per cell
                              ▼
   resolveVerificationSequence(tier, boundary)            (slice 1 — frozen built-in table, UNCHANGED)

   Consumers (all read the RESOLVED policy — one resolver, every call site):
     • prepare_delegation  → stamps task.verificationSequence     (prepare-delegation.ts:405)
     • resolvePolicySkip   → gate self-skip decision              (gate-utils.ts)
     • playbooks           → gate-name references
   Severity stays on the EXISTING surface: review.gates / review.dimensions
   (resolveGateSeverity), extended only with workflow-type awareness (oneshot → warning).
```

The six policy cells are `(low|medium|high) × (base|boundary)`. Resolution is **cell-wise full
replacement**: a configured cell wins verbatim; an absent cell falls back to the built-in cell
(which for boundary cells is the slice-1 base+append result). No delta merging (`add:`/
`remove:` forms) — replacement is explicit, deterministic, and trivially diffable, mirroring
how `toolchains:` entries override built-ins wholesale rather than patching them.

## Technical Design

### 4.1 `verification:` config block

New top-level key in `ProjectConfigSchema` (`config/yaml-schema.ts`) — **not**
`ExarchosConfigSchema` (`exarchos-config-schema.ts`), because the consumers
(`prepare_delegation`, gates) read `ResolvedProjectConfig` from `config/resolve.ts`:

```yaml
verification:
  policy:                      # all keys optional; absent cell → built-in cell
    low: [check_static_analysis]
    medium: [check_static_analysis, check_test_adequacy]
    high: [check_static_analysis, check_test_adequacy, check_integration_suite]
    boundary:                  # boundaryTouching = true cells
      low: [check_static_analysis, check_contract_drift]
      medium: [...]
      high: [...]
```

Zod shape: `.strict()` at every level; sequence values `z.array(z.enum(VERIFICATION_GATE_NAMES))`
with a duplicate-free `.refine`; empty arrays permitted (an explicit "run nothing for this
cell" is a legitimate consumer decision and is visibly logged by the skip reason, §4.3).
`GateName`/`VERIFICATION_GATE_NAMES` are imported from `workflow/verification-policy.ts` — the
single source of truth; the schema must never re-declare the name list. `resolve.ts` threads
the parsed block onto `ResolvedProjectConfig.verification` with `DEFAULTS.verification =
{ policy: {} }` (empty override layer). Unknown gate names fail at parse time with the standard
Zod error envelope — config validation, not gate-time surprise.

**Plan-time verify:** the repo's `.exarchos.yml` already carries keys (`review:`, `agents:`)
unknown to the strict `ExarchosConfigSchema`, so the toolchain loader demonstrably tolerates
foreign top-level keys; confirm the same holds for `verification:` on that path (a
`RepoConfig`-style round-trip test).

### 4.2 `resolveVerificationPolicy` — the layered resolver

New sibling module `workflow/verification-policy-resolver.ts` (the slice-1 table module stays
byte-for-byte config-free, honoring its own header contract). Exported surface:

```ts
resolveVerificationPolicy(
  riskTier: RiskTier,
  boundaryTouching: boolean,
  config?: ResolvedProjectConfig,
): { sequence: readonly GateName[]; source: 'builtin' | 'config' }
```

Synchronous and pure over its inputs — same discipline as `resolveTestRuntime` (layered,
per-field, no I/O). `config` absent or cell unset → delegate to
`resolveVerificationSequence(tier, boundary)` with `source: 'builtin'`; cell set → the
configured array verbatim (frozen) with `source: 'config'`. The `source` discriminant is not
decoration: it flows into the gate-skip reason (§4.3) and the doctor visibility surface (§4.7),
so an operator can always answer "why did/didn't this gate run?" from the output alone
(INV-5b honesty). The resolver is the **only** module that composes config with the table;
every consumer call site imports it rather than `resolveVerificationSequence` directly —
preventing the stamp-vs-skip desync hazard (§5).

Unit tests: cell-wise override wins / absent-cell fallback / empty-array cell / frozen output /
`source` correctness — plus a property-style sweep asserting that with no config the resolver
is extensionally identical to the slice-1 table for all six cells (the "additive, no behavior
change by default" acceptance line of #1517).

### 4.3 Consumer rewiring

Three call sites move from the frozen table to the resolver, none changing shape:

1. **`prepare_delegation`** (`orchestrate/prepare-delegation.ts:405`): the
   `verificationSequence` stamp becomes `resolveVerificationPolicy(riskTier, boundaryTouching,
   config).sequence`. The `TaskClassification` field type is unchanged (`readonly GateName[]`),
   so delegation records, dispatch prompts, and `next_actions` carry resolved sequences with
   zero schema churn — and zero new action input fields (sidestepping the
   `buildRegistrationSchema` collision trap entirely).
2. **`resolvePolicySkip`** (`orchestrate/gate-utils.ts`): gains an optional `config` parameter
   and resolves through the same resolver. The skip reason string is extended with the policy
   source: `"…(sequence: …, policy: config)"` so a config-induced skip is never mistaken for a
   built-in decision. Absent-stamp behavior is preserved exactly (both stamps required, else
   run unconditionally).
3. **Playbooks** (`workflow/playbooks.ts`): continue referencing gate names through the policy
   surface, never literals — audit during implementation that no slice-1 reference bypasses the
   resolver.

R7's tier-conditional prompt assembly already reads the stamped sequence off the delegation
record, so it inherits config-resolved policy with no change — verify with one characterization
test rather than new plumbing.

### 4.4 Per-workflow severity (oneshot → advisory)

#1517's acceptance requires gate sequencing to respect per-workflow severity (oneshot
advisory). Severity already has a home — `resolveGateSeverity` layering `review.gates[gate]` >
`review.dimensions[dim]` > blocking — and slice 1 already seeds ladder-gate defaults into
`DEFAULTS.review.gates`. We extend that resolution with one workflow-aware layer rather than
growing a parallel severity surface under `verification:`: `resolveGateSeverity` (or a thin
wrapper taking `workflowType`) resolves verification-ladder gates to `warning` when
`workflowType === 'oneshot'` **unless** an explicit `review.gates[gate]` override says
otherwise — explicit config always wins, mirroring the invariants catalog's
`severity.by-workflow` precedent. The workflow-type → default-severity fact is expressed as a
data table in the severity module (INV-6: data, not branching prose in skills).

**Non-goal — per-tier severity** (e.g. `check_test_adequacy` blocking at high but warning at
medium): the tier axis already controls *whether* a gate runs (the sequence); severity controls
*how hard a failure lands*. Crossing the two axes multiplies the config surface without a
driving use case in the epic or research docs. If a real consumer need appears, it composes
onto `review.gates` later without breaking this shape.

### 4.5 R9 — DesiredState + detect + seed (commands only)

`ResolvedCommandsSchema` (`core/onboarding/types.ts`) grows `mutation: z.string().optional()`
and `lint: z.string().optional()` — same optionality semantics as the existing fields (the
layered resolver may leave any field unresolved). `detectDesiredState` switches its resolution
call from `resolveTestRuntime` to the slice-1 `resolveVerificationRuntime` (same module, wider
field set, same tier order), populating the new fields. The diff step then naturally emits a
`config`-kind PlanStep when resolved commands are missing from `.exarchos.yml`, and `apply` /
`doctor --fix` seeds them — **the same seed path test/typecheck use today**, no new step kinds,
no new surfaces (INV-2: one reconciler core, two callers).

Seeding commands is correct where seeding policy would not be: a seeded command is the
operator's explicit tier-2 declaration the resolver honors above detection — onboarding's whole
purpose — and it goes stale only if the repo's toolchain changes (which `doctor` re-detects).
A seeded *policy default* would freeze today's built-in table into consumer config, silently
diverging as the built-in evolves — the gen-time-placeholder trap (#1483) in config form.
Accordingly, this design **reframes** #1524's "DesiredState carries verification-policy
defaults" line: the resolved policy is surfaced read-only through doctor (§4.7) for
visibility/drift purposes; `apply` never writes a `verification:` block. The reframe is recorded
on the issue at synthesis time.

### 4.6 Doctor check — `verification-toolchain`

New `orchestrate/doctor/checks/verification-toolchain.ts`, registered in `ALL_CHECKS`
(`doctor/index.ts`), following the established probe-based `CheckFn` contract
(cf. `invariants-catalog.ts`). The probe calls `resolveVerificationRuntime` for the repo and
reports per-field resolvability — today **no** doctor check covers this (confirmed gap; the
ladder's gates degrade silently to skipped/advisory when commands don't resolve).

Status mapping (final wording at plan time): **Pass** — `test`, `typecheck`, and `mutation` all
resolve (the #1524 acceptance triple; `lint` named informationally); **Warning** — any of the
triple unresolved, with `fix:` naming the two remedies (`doctor --fix` to seed what detection
found; or declare the field in `.exarchos.yml` / `toolchains:` for toolchains detection can't
see); **Skipped** — no toolchain detectable at all (empty repo), with the reason naming what
detection looked for. The check's detail payload also carries the **resolved policy source**
per cell (`builtin`/`config` from §4.2) — this is the read-only policy visibility that replaces
config seeding (§4.5). Like every check it is read-only; the *fix* path is the reconciler's,
keeping detect/diff/apply as the single mutation surface (INV-2).

### 4.7 T0 characterization

Before any reconciler/doctor extension lands: characterization tests pinning (a) the current
12-check doctor roster output shape (names, categories, status vocabulary) and (b) the current
`DesiredState`/`ReconcilePlan` shapes for a representative fixture repo — written against the
real loader/reconciler (per the dev-catalog precedent: test file-writers by re-parsing through
the real loader, not against hand-built literals). These tests are the safety net the epic's
test plan requires ("Feathers characterization … before any demotion/fold") and double as the
regression harness for the `ResolvedCommandsSchema` widening — the existing-field behavior must
be byte-identical after the slice.

## 5. Conformance summary & known hazards

| Surface | Invariants | Note |
|---|---|---|
| `verification:` block | INV-5a, INV-6 | Strict Zod, enum-constrained names; policy as config data |
| Policy resolver | INV-6, INV-1, INV-4 | Pure layering; table untouched; resolve-never-bake |
| Consumer rewiring | INV-12, INV-5b | Same stamp shape; skip reasons carry policy source |
| Per-workflow severity | INV-6 | Data table in severity module; explicit config wins |
| DesiredState/seed | INV-2, INV-4 | One reconciler core; commands seeded, policy never |
| Doctor check | INV-2, INV-5b | Read-only; fix path stays in reconciler |

**Hazards (named traps from the repo's memory):**

- **Stamp-vs-skip desync** — if any call site keeps importing `resolveVerificationSequence`
  directly while others use the resolver, a configured override skips gates the stamp promised
  (or vice versa). Mitigation: the resolver is the only composing module; an ESLint-able grep
  in review (`resolveVerificationSequence(` outside the resolver + table tests) plus a
  round-trip test stamping and skipping under the same config.
- **Registration-schema field collision** — no orchestrate action gains new input fields in
  this slice; if the plan introduces any (it should not), field name+type must match across
  actions or `buildRegistrationSchema` throws at MCP startup.
- **Composite dispatch handler gap** — N/A by construction: zero new actions. State explicitly
  in the plan so no task invents one.
- **Two-schema config split** — `verification:` goes in `yaml-schema.ts` only; adding it to the
  strict `ExarchosConfigSchema` too would create a second parse authority (and the loaders'
  unknown-key tolerance needs the §4.1 round-trip test).
- **Doctor roster count** — #1524 says "12th check" but the roster already has 12 (it predates
  `invariants-catalog`); the design adds the 13th. Cosmetic, but fix the issue text at
  synthesis so the docs don't ship a wrong count.

## 6. Acceptance & test plan

- Default policy resolution extensionally identical to slice 1's table when no
  `verification:` block is configured (property sweep over all six cells) — #1517's "additive"
  line.
- `.exarchos.yml` override unit tests: cell replacement, absent-cell fallback, empty cell,
  unknown-gate parse rejection, duplicate rejection.
- Oneshot workflows resolve ladder-gate failures to advisory unless explicitly overridden;
  feature workflows unchanged.
- Stamp/skip round-trip: a configured cell produces matching `verificationSequence` stamps and
  `resolvePolicySkip` decisions, with `policy: config` in the skip reason.
- R9: `detectDesiredState` resolves `mutation`/`lint`; `doctor --fix` seeds them; re-run is
  idempotent (empty plan). T0 characterization green before and after.
- `verification-toolchain` check: Pass/Warning/Skipped mapping unit-tested through
  `handleDoctorWithChecks` (dispatch-through, per the handler-gap lesson).
- Full: `npm run test:run` (root + `servers/exarchos-mcp`), `npm run typecheck`,
  `npm run lint:invariants` green.
