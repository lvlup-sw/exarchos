# Strategos issues for exarchos v3.1.0 Workflow Builder SDK

**Date:** 2026-05-06
**Status:** Filed; milestone consolidated into `Strategos 2.7.0 — Convergence`
**Driver:** [exarchos#1258 — Epic: Workflow Builder SDK (v3.1.0)](https://github.com/lvlup-sw/exarchos/issues/1258)

## Question

What does Strategos need to ship for exarchos v3.1.0 to land?

## Sources

- [exarchos#1258](https://github.com/lvlup-sw/exarchos/issues/1258) — Workflow Builder SDK epic
- [exarchos#1247 (P1)](https://github.com/lvlup-sw/exarchos/issues/1247) — IR substrate (DR-2)
- [exarchos#1256 (P10)](https://github.com/lvlup-sw/exarchos/issues/1256) — Strategos integration (T1/T5/T6 + R4)
- [exarchos#1125](https://github.com/lvlup-sw/exarchos/issues/1125) — consumer side of `Strategos.Contracts`
- [strategos#36](https://github.com/lvlup-sw/strategos/issues/36) — `Strategos.Contracts` (events-only today, unmilestoned)
- [`docs/designs/archive/2026-05-06-workflow-builder-sdk.md`](../designs/archive/2026-05-06-workflow-builder-sdk.md) — DR-1…DR-12, §Strategos Integration, R4
- [`docs/designs/archive/2026-04-18-strategic-framing-exarchos-basileus.md`](../designs/archive/2026-04-18-strategic-framing-exarchos-basileus.md)
- Strategos open milestones: `Ontology 2.5.0` (#1), `Ontology 2.6.0` (#2). No workflow milestone exists.

## Findings

### F1. `#36` is events-only and unmilestoned

The current `Strategos.Contracts` issue covers the 26-event TypeSpec surface (`SdlcEventEnvelope`, ontological-record lifecycle, fabric query audit, remote delegation). It does not cover workflow IR, and exarchos `#1247` blocks on that extension.

### F2. Strategos has the C# definitions; it lacks the TypeSpec source

`src/Strategos/Definitions/*.cs` ships all 18 records (`WorkflowDefinition`, `StepDefinition`, `TransitionDefinition`, `BranchPointDefinition`, `BranchPathDefinition`, `BranchCase`, `LoopDefinition`, `ForkPointDefinition`, `ForkPathDefinition`, `ApprovalDefinition`, `ApprovalEscalationDefinition`, `ApprovalRejectionDefinition`, `FailureHandlerDefinition`, `StepConfigurationDefinition`, `RetryConfiguration`, `CompensationConfiguration`, `ValidationDefinition`, `LowConfidenceHandlerDefinition`). The missing piece is TypeSpec source that emits matching JSON Schema for exarchos to consume.

### F3. The C# records become generated output

Per user decision, the migration is a single-step swap: in the same PR that lands TypeSpec source, hand-authored `Definitions/*.cs` is deleted and replaced with generated code. Two sources of truth is a DIM-5 hygiene risk; the swap eliminates it before it ships.

### F4. Fixture export belongs on the Strategos side and must use the runtime serializer

The ~3,400 builder cases in `Strategos.Tests/Builders/*.cs` are .NET-bound. A standalone exporter that writes JSON via a sidecar serializer would diverge from runtime serialization (DIM-4 risk). The exporter must call the same `WorkflowDefinition<TState>` → JSON path that production code uses, so fixture and runtime cannot drift.

### F5. AGWF catalog must be the single source

Today `AGWF001`–`AGWF014` exist in analyzer code, runtime checks, and (informally) docs. Without a single canonical artifact, parallel lists drift. Resolution: one catalog file (TypeSpec or embedded JSON), all consumers (analyzers, runtime, exporter, downstream exarchos) read from generated output of that file.

### F6. `IWorkflowBuilder<TState>` becomes a published contract surface

Exarchos's R4 mitigation parses the C# interface for drift. That elevates seven interfaces to versioned API: `IWorkflowBuilder`, `IBranchBuilder`, `ILoopBuilder`, `IForkJoinBuilder`, `IApprovalBuilder`, `IFailureBuilder`, `IStepConfiguration`. They need a public-API baseline test on the Strategos side that fires before exarchos's CI does.

### F7. T4 is deferred

`StepDefinition.runtime: "exarchos" | "strategos" | "remote"` is reserved in the TypeSpec but not wired. v3.3.0 owns federation; no Strategos work for v3.1.0 beyond reserving the field.

### F8. Strategos has no milestone for this work

Both open milestones are ontology-scoped. exarchos v3.1.0 has a hard dependency on landing the four issues below. A new milestone groups them and signals release timing.

## Resolved decisions (from review)

| Question | Decision |
|---|---|
| `Strategos.Contracts` version bump | `0.2.0` — additive contract surface |
| C# definition migration mode | Single-step swap; hand-authored `Definitions/*.cs` deleted in the same PR |
| Fixture distribution channel | Embedded in `Strategos.Contracts` NuGet (versioned with the contract) |
| `IWorkflowBuilder<TState>` breaking-change protocol | Both: CHANGELOG release notes + auto-opened cross-repo issue on `lvlup-sw/exarchos` |

## Resolved decisions (review round 2)

| Question | Decision |
|---|---|
| Milestone title | `Strategos.Contracts 0.2.0 — Workflow IR Convergence` (matches `Ontology 2.5.0 — Coordination Floor` idiom) |
| Issue A vs scope-extending #36 | New sibling. #36 stays as the events-only umbrella. |

## Cross-product invariants (apply to every issue below)

These are DIM-3 obligations that must show up in acceptance criteria:

- **Schema versioning.** `WorkflowDefinitionV1.schemaVersion: "1.0"` literal in TypeSpec. Minor bumps are additive; major bumps break.
- **Drift fails closed.** CI gates fail the build, not warn. No green-with-known-divergence.
- **Single source.** Every artifact (C# records, JSON Schema, AGWF enum, fixtures) is generated from one file. No parallel hand-authored copies.
- **Round-trip.** An exarchos-emitted IR JSON must validate against this milestone's emitted JSON Schema and vice versa.

## Proposed Strategos issues

Each issue below is a ready-to-file body. All carry `scope:workflow`, `type:feature`, `status:triage`, and the new milestone.

---

### Issue A — TypeSpec workflow IR (extends `Strategos.Contracts` 0.2.0)

**Title:** `Strategos.Contracts 0.2.0: TypeSpec workflow IR (18 sub-definitions, single-step swap of Definitions/*.cs)`

**Labels:** `type:feature`, `scope:workflow`, `priority:high`, `status:triage`

**Depends on:** #36

**Cross-repo blocker for:** [exarchos#1247](https://github.com/lvlup-sw/exarchos/issues/1247) (P1), [exarchos#1258](https://github.com/lvlup-sw/exarchos/issues/1258)

**Body:**

> Extend `Strategos.Contracts` from events-only (#36) to events + workflow IR. `0.2.0` minor bump.
>
> **Models (18, 1:1 with `src/Strategos/Definitions/*.cs`):**
> `WorkflowDefinitionV1`, `StepDefinition` (discriminated: `skill | handler | gate | delegate | approval`), `TransitionDefinition`, `BranchPointDefinition`, `BranchPathDefinition`, `BranchCase`, `LoopDefinition`, `ForkPointDefinition`, `ForkPathDefinition`, `ApprovalDefinition`, `ApprovalEscalationDefinition`, `ApprovalRejectionDefinition`, `FailureHandlerDefinition`, `StepConfigurationDefinition`, `RetryConfiguration`, `CompensationConfiguration`, `ValidationDefinition`, `LowConfidenceHandlerDefinition`.
>
> Reserve `StepDefinition.runtime: "exarchos" | "strategos" | "remote"` (optional, default `"exarchos"`) for v3.3.0 federation.
>
> **Schema versioning.** `WorkflowDefinitionV1.schemaVersion: "1.0"` literal at IR root. Future minor bumps additive only; breaking changes require V2.
>
> **Migration: single-step swap.** Same PR that lands TypeSpec source:
> - emits generated C# records to `src/Strategos/Definitions.Generated/`,
> - replaces wiring to point at the generated namespace,
> - deletes hand-authored `src/Strategos/Definitions/*.cs`.
>
> **Build pipeline.**
> - TypeSpec source under `src/Strategos.Contracts/Workflow/`.
> - JSON Schema emitted to `src/Strategos.Contracts/schemas/workflow/` and embedded as NuGet content.
> - Spike-known issues (`$ref` dereferencing, `int64` mapping, reserved-word handling) addressed in the build.
>
> **Acceptance criteria.**
> - [ ] All 18 sub-definitions present in TypeSpec; `tsp compile` succeeds.
> - [ ] JSON Schema artifact `workflow-definition-v1.schema.json` emitted with stable `$id`.
> - [ ] Generated C# records consumed by `Strategos` core; `grep -r "namespace Strategos.Definitions[^.]" src/Strategos/Definitions/` returns zero hits.
> - [ ] Round-trip: a `WorkflowDefinition<TState>` from any `Strategos.Tests/Builders` case serializes to JSON that validates against the emitted schema.
> - [ ] Cross-product round-trip (coordinated with exarchos#1247): an exarchos-emitted IR JSON validates against the schema, and an IR fixture from this repo parses against exarchos's generated Zod.
> - [ ] CI codegen-guard fails when generated files are hand-edited.
> - [ ] Hand-authored `Definitions/*.cs` files deleted in the same PR (verified by file count, not just diff).
>
> **References.**
> - exarchos design: `docs/designs/archive/2026-05-06-workflow-builder-sdk.md` §The IR Substrate, DR-2
> - exarchos plan: T-001…T-006

---

### Issue B — Builder fixture export (uses runtime serializer)

**Title:** `Strategos.Tests fixture export: ≥ 100 builder cases → JSON IR via runtime serializer`

**Labels:** `type:feature`, `scope:workflow`, `status:triage`

**Cross-repo blocker for:** [exarchos#1256](https://github.com/lvlup-sw/exarchos/issues/1256) (P10) — T5

**Depends on:** Issue A

**Body:**

> Export `Strategos.Tests/Builders/*.cs` cases as JSON IR fixtures. Exarchos consumes them as Zod validation cases.
>
> **Constraint (DIM-4 fidelity).** The exporter must call the same serialization path that production code uses. No sidecar writer, no parallel JSON shaping. If runtime serialization changes, fixtures change in the same commit.
>
> **Approach.**
> - New test category `Category=FixtureExport` in `Strategos.Tests`.
> - Each test runs an existing builder case, captures `WorkflowDefinition<TState>`, and writes via `Strategos.Contracts`'s canonical serializer (Issue A) to `artifacts/builder-fixtures/<category>/<test-name>.json`.
> - Manifest `index.json` enumerates fixtures with combinator-coverage tags (`startWith`, `then`, `branch`, `repeatUntil`, `fork-join`, `awaitApproval`, `onFailure`, configuration variants).
>
> **Distribution.** Embedded in the `Strategos.Contracts` 0.2.0 NuGet under `contentFiles/any/any/fixtures/`. Exarchos pins the contract version and extracts at build time.
>
> **Acceptance criteria.**
> - [ ] `dotnet test --filter Category=FixtureExport` produces ≥ 100 JSON fixtures across all 8 combinator-coverage tags (≥ 1 per tag).
> - [ ] Every emitted fixture validates against the JSON Schema from Issue A.
> - [ ] Manifest schema present and validated.
> - [ ] Partial export rejected: a single test failure fails the run, no half-written `artifacts/` directory.
> - [ ] Fixtures NuGet-content path verified by a smoke test that unpacks the published `.nupkg`.
> - [ ] Exporter uses `Strategos.Contracts` serializer; no parallel `JsonSerializer.Serialize` call sites in the export code (grep verified).
>
> **References.**
> - exarchos design: §Strategos Integration → T5
> - exarchos plan: T-078

---

### Issue C — AGWF diagnostic catalog (single source)

**Title:** `AGWF001–AGWF014: single-source catalog (TypeSpec → JSON enum + C# enum + Markdown reference)`

**Labels:** `type:feature`, `scope:workflow`, `type:docs`, `status:triage`

**Cross-repo blocker for:** [exarchos#1256](https://github.com/lvlup-sw/exarchos/issues/1256) (P10) — T6

**Body:**

> Promote AGWF codes to a single canonical artifact. Today they are spread across analyzer source, runtime checks, and informal docs. exarchos v3.1.0 needs a 1:1 mapping target.
>
> **Source of truth.** `src/Strategos.Contracts/Diagnostics/AgwfCatalog.tsp`. One entry per code: `id`, `severity` (`error | warning | info`), `summary`, `remediation`, `since` (semver).
>
> **Generated outputs (single PR).**
> - `agwf-catalog.json` (NuGet content artifact).
> - `LevelUp.Strategos.Contracts.Diagnostics.AgwfCode` C# enum.
> - `docs/diagnostics/agwf.md` reference page (Markdown table).
>
> **Consumers (rewired in the same PR, DIM-5 hygiene).** Strategos analyzers and runtime read from the generated enum; no hand-authored `case "AGWF003":` switch arms or string literals remain. Verified by grep:
> - `grep -rn 'AGWF0[0-9]\{2\}' src/Strategos/ --include='*.cs' | grep -v Generated/` returns zero hits.
>
> **Change-control.** Adding a code is a minor bump. Renaming or removing is a major bump.
>
> **Acceptance criteria.**
> - [ ] `AgwfCatalog.tsp` contains all 14 codes with full metadata.
> - [ ] `agwf-catalog.json` and C# enum generated; CI fails on hand-edits.
> - [ ] Zero hand-authored AGWF string literals in non-generated source (grep gate).
> - [ ] Markdown reference page generated from the catalog.
> - [ ] Exarchos can consume `agwf-catalog.json` and produce a TS enum that round-trips by name.
>
> **References.**
> - exarchos design: §Strategos Integration → T6, DR-10

---

### Issue D — `IWorkflowBuilder<TState>` API stability + cross-repo drift detection

**Title:** `IWorkflowBuilder<TState>: PublicAPI baseline + CHANGELOG protocol + auto-opened drift issue on lvlup-sw/exarchos`

**Labels:** `type:feature`, `scope:workflow`, `priority:high`, `status:triage`

**Cross-repo coordination with:** [exarchos#1256](https://github.com/lvlup-sw/exarchos/issues/1256) (P10) — R4

**Body:**

> Treat the seven builder interfaces as a published contract. Exarchos's `strategos-api-mirror.test.ts` parses these signatures; drift detection on the Strategos side fires before exarchos CI does.
>
> **Baselined surface (7 interfaces).** `IWorkflowBuilder<TState>`, `IBranchBuilder<TState>`, `ILoopBuilder<TState>`, `IForkJoinBuilder<TState>`, `IApprovalBuilder<TState>`, `IFailureBuilder<TState>`, `IStepConfiguration<TState>`.
>
> **Tooling.**
> - `Microsoft.DotNet.PublicApiAnalyzers` with `PublicAPI.Shipped.txt` / `PublicAPI.Unshipped.txt` per project.
> - Baseline scope = the 7 interfaces only (not the whole `Strategos.Abstractions` surface, to keep the gate signal-rich).
>
> **CHANGELOG.** Every release that bumps `Strategos.Contracts` includes a `## Cross-product breaking changes` section, even when empty (forces the author to think about it).
>
> **Auto-issue (cross-repo).** A GitHub Action on `main` opens an issue on `lvlup-sw/exarchos` when `PublicAPI.Shipped.txt` diverges from the previous tag. Issue body links the diff and tags `cross-product:strategos`. Workflow uses a fine-grained PAT scoped to issues:write on `lvlup-sw/exarchos`.
>
> **Failure mode (DIM-7 fails closed).** A baseline change without a matching `Unshipped` entry fails CI. The CI message names the protocol: "Update PublicAPI.Unshipped.txt and add a CHANGELOG entry under Cross-product breaking changes."
>
> **Acceptance criteria.**
> - [ ] `PublicAPI.Shipped.txt` baseline committed for the 7 interfaces.
> - [ ] CI fails on baseline divergence with the named remediation message.
> - [ ] Auto-issue workflow tested via a dry-run divergence; opens an issue on `lvlup-sw/exarchos` with the correct labels and a link to the public-API diff.
> - [ ] CHANGELOG protocol documented in `CONTRIBUTING.md`.
> - [ ] Doc-comment on `IWorkflowBuilder<TState>.cs` references the protocol.
>
> **References.**
> - exarchos design: §Risks R4
> - exarchos plan: T-080

---

### Issue E — Coordination meta-issue

**Title:** `Workflow IR Convergence (exarchos v3.1.0): tracking + acceptance gate`

**Labels:** `type:epic`, `scope:workflow`, `priority:high`, `status:triage`

**Body:**

> Tracks Strategos's commitments to [exarchos#1258](https://github.com/lvlup-sw/exarchos/issues/1258).
>
> | Tier | Issue | Exarchos consumer |
> |---|---|---|
> | T1 | Issue A — TypeSpec workflow IR | exarchos#1247 |
> | T5 | Issue B — Fixture export | exarchos#1256 |
> | T6 | Issue C — AGWF catalog | exarchos#1256 |
> | R4 | Issue D — API stability | exarchos#1256 |
> | T4 | (deferred) | exarchos v3.3.0 |
>
> **Milestone close gate.**
> - All four child issues closed.
> - `Strategos.Contracts` 0.2.0 published.
> - exarchos cross-product round-trip test green: an exarchos-emitted IR JSON validates against this milestone's JSON Schema, and a Strategos fixture parses against exarchos's generated Zod.
> - exarchos `strategos-api-mirror.test.ts` green against the 0.2.0 baseline.
>
> **Out of scope.** T4 cross-runtime dispatch (saga compensation across event stores) — exarchos v3.3.0 + future Strategos remoting milestone.
>
> **References.**
> - Strategic framing: [`basileus/docs/decisions/2026-04-18-strategic-framing-exarchos-basileus.md`](https://github.com/lvlup-sw/basileus/blob/main/docs/decisions/2026-04-18-strategic-framing-exarchos-basileus.md)
> - exarchos design: [`docs/designs/archive/2026-05-06-workflow-builder-sdk.md`](https://github.com/lvlup-sw/exarchos/blob/main/docs/designs/archive/2026-05-06-workflow-builder-sdk.md)

---

## Recommended milestone

**Title:** `Strategos.Contracts 0.2.0 — Workflow IR Convergence`

**Description:**
> Strategos prerequisites for the exarchos Workflow Builder SDK epic ([exarchos#1258](https://github.com/lvlup-sw/exarchos/issues/1258), v3.1.0). Extends `Strategos.Contracts` from events-only (#36) to events + workflow IR (`0.2.0`), ports ≥ 100 builder fixtures via the runtime serializer, canonicalizes the AGWF catalog as a single source, and adds a public-API baseline + cross-repo drift detection on `IWorkflowBuilder<TState>`. Cross-runtime dispatch (T4) deferred to a later milestone.

## Filing log

### Final milestone shape (after rightsizing review)

The original `Strategos.Contracts 0.2.0 — Workflow IR Convergence` milestone was renamed and rescoped to track a Strategos main release. Strategos uses unified MinVer-driven versioning: existing milestones (`Ontology 2.5.0`, `Ontology 2.6.0`) map to Strategos main releases. The Contracts package debuts at 0.2.0 inside the Strategos 2.7.0 release; no separate 0.1.0 ships.

| Milestone | Open | Scope |
|---|---|---|
| [Ontology 2.5.0 — Coordination Floor (#1)](https://github.com/lvlup-sw/strategos/milestone/1) | 12 | Coordination-floor seams + absorbed cleanups (#23, #32, #33) |
| [Ontology 2.6.0 — Hybrid Retrieval Seams (#2)](https://github.com/lvlup-sw/strategos/milestone/2) | 1 | #47 |
| [**Strategos 2.7.0 — Convergence** (#3)](https://github.com/lvlup-sw/strategos/milestone/3) | 7 | Slice (A) Contracts foundation #36; Slice (B) Workflow IR #50–#54; Slice (C) Agents MEAI 10.5 #45 |

### Slice B issues (this discovery's deliverables)

| Issue | Title | URL |
|---|---|---|
| A (T1) | TypeSpec workflow IR | [lvlup-sw/strategos#50](https://github.com/lvlup-sw/strategos/issues/50) |
| D (R4) | IWorkflowBuilder PublicAPI baseline | [lvlup-sw/strategos#51](https://github.com/lvlup-sw/strategos/issues/51) |
| C (T6) | AGWF single-source catalog | [lvlup-sw/strategos#52](https://github.com/lvlup-sw/strategos/issues/52) |
| B (T5) | Fixture export via runtime serializer | [lvlup-sw/strategos#53](https://github.com/lvlup-sw/strategos/issues/53) |
| E | Slice-B sub-tracker (was umbrella) | [lvlup-sw/strategos#54](https://github.com/lvlup-sw/strategos/issues/54) |

**Slice ordering inside 2.7.0.** (B) blocks on (A); (C) is independent.

**Cross-links posted on exarchos:**
- [exarchos#1247 comment](https://github.com/lvlup-sw/exarchos/issues/1247#issuecomment-4394488562)
- [exarchos#1256 comment](https://github.com/lvlup-sw/exarchos/issues/1256#issuecomment-4394488911)
- [exarchos#1258 comment](https://github.com/lvlup-sw/exarchos/issues/1258#issuecomment-4394489214)

### Out of scope for this milestone

- `#24` (`Agentic.*` namespace references in generators, `status:stale`) — left unmilestoned; recommend triaging separately (close as superseded or assign to a future maintenance milestone).
