## Spec Traceability

### Traceability Matrix

| Design Section | Key Requirements | Task ID(s) | Status |
|----------------|-----------------|------------|--------|
| Problem Statement | Phases are snowflakes; the verification ladder reaches only 2/5 implement phases | task-001..007 | Covered |
| Chosen Approach (Option 1) | Thin dispatcher — bind each phase to a `PhaseKind`, resolve obligations from a frozen kind table at the boundary | task-001, task-003, task-004 | Done |
| Approaches Considered | Documented in design §"Approaches Considered" | — | Covered |
| Option 1: Thin dispatcher over existing resolvers (chosen) | Reuse `resolveVerificationPolicy` behind a kind-keyed resolver | task-002, task-004 | Done |
| Option 2: Unified key-space table | Rejected — heavier; couples kind to workflow type | — | N/A (not chosen) |
| Requirements | DR-1..DR-7 | task-001..007 | Done |
| DR-1: `PhaseKind` union + frozen `KIND_OBLIGATIONS` table | Closed union + `satisfies Record<PhaseKind,…>`; INV-6 (no workflow/phase literals) | task-001 | Done |
| DR-2: kind-tag every HSM state (behavior-neutral) | `State` discriminated union; `kind` required on atomic states only; full state→kind map; zero transition diff | task-003 | Done |
| DR-3: `resolveGateSet(phaseKind, ctx)` resolver (behavior-neutral) | IMPLEMENT delegates verbatim to `resolveVerificationPolicy`; GATHER→[]; deferred resolvers throw | task-002 | Done |
| DR-4: route every IMPLEMENT phase through the resolver | `classifyTask` → `resolveGateSet('IMPLEMENT')`; reachability for all 6 implement phases | task-004 | Done |
| DR-5: delete hardcoded TDD prose from implement playbooks | 4 work-implement playbooks → risk-proportional ladder; transition/escalation retained | task-005 | Done |
| DR-6: severity + audit→enforce graduation | Per-workflow severity + `IMPLEMENT_PHASE_MODE` (oneshot→audit, feature/debug/refactor→enforce); reuses `review.gates.*`; kept out of `KIND_OBLIGATIONS` (INV-6) | task-006 | Done |
| DR-7: Error handling, fail-closed resolution, and invariant guards | Resolver throw → `phase.blocked` + refuse; absent config → base table; visible tool count unchanged | task-007 | Done |
| Technical Design | `phase-kind.ts` (union+table+resolver), `state-machine.ts` (discriminated union), `gate-utils.ts`/`composite.ts` (severity+mode), `prepare-delegation.ts` (fail-closed), `event-store/schemas.ts` (`phase.blocked`) | task-001..007 | Done |
| Integration Points | `classifyTask` boundary; ladder severity/mode post-processing; `phase.blocked` event | task-004, task-006, task-007 | Done |
| Testing Strategy | Kind-table exhaustiveness, full state→kind map, tier×boundary parity, IMPLEMENT reachability, prose guard, severity/audit (incl. no-config), fail-closed boundary, registry tool-count fence, phase-kind drift guard | task-001..007 | Done |
| Invariant Conformance | INV-6 (kind table holds no workflow/phase literals; severity/mode out of `KIND_OBLIGATIONS`), INV-5b (advisory-carrier downgrade clears `data.passed`), INV-5d (visible tool count unchanged) | task-001, task-006, task-007 | Done |
| Open Questions | Mode default for newly-covered phases reconciled to the design's binding AC (oneshot→audit, feature/debug/refactor→enforce); S3/S4 deferred | task-006 | Resolved |

### Scope Declaration

**Target:** S1 + S2 — DR-1..DR-7 (foundation + verification-ladder reach on every IMPLEMENT phase).

**Excluded:**
- **S3** (#1549) — PLAN/REVIEW/SYNTHESIZE resolver wiring; the inert resolver slots stay throwers (`not-yet-wired`).
- **S4** (#1550) — POLA capability bundle + resolve-then-freeze `phase.entered`/`phase.exited` events; the `posture` field is authored but inert.
