# Spec Traceability — Verification Ladder Slice 1

Generated via `generate_traceability`, filled per `check_plan_coverage` (PASS 7/7).

- **Design:** `docs/designs/2026-06-09-verification-ladder-slice1.md`
- **Plan:** `docs/plans/2026-06-09-verification-ladder-slice1.md`

## Traceability Matrix

| Design Section | Key Requirements | Task ID(s) | Status |
|----------------|-----------------|------------|--------|
| 4.1 Classification spine — R1 + SIV-1 (#1516, #1527) | riskTier + boundaryTouching derived mechanically from files/blockedBy/testLayer + glob tables; explicit override wins; no LLM in hot path | 002, 003, 004, 005, 009 | Covered |
| 4.2 Interim verification policy table | Frozen const (tier × boundary) → ordered gate names beside review-contract.ts; no config reads (R2 line); consumed by prepare_delegation + playbooks | 006, 007, 008 | Covered |
| 4.3 Kill-probe + demotion — R3 (#1518) | check_test_adequacy (revert → red → restore, INV-14 refuse-to-discard, explicit discriminants); check_tdd_compliance default → advisory, events keep flowing | 010, 011, 012, 013, 014, 015 | Covered |
| 4.4 Toolchain extension + verbs + drift gate — R4 + SIV-2 (#1519, #1528) | ToolchainCommands mutation/lint/contract + seeds; resolveVerificationRuntime; run-mutation/run-contract verbs; check_contract_drift (merge-base baseline, skipped/advisory degrade); INV-10 liveness | 016, 017, 018, 019, 020, 021, 022, 023 | Covered |
| 4.5 Mock-boundary check — SIV-4 (#1530) | Ownership manifest; Hora-Robbes heuristic over test diffs; advisory default; steer-to-hermetic next_actions; logged escape hatch | 024, 025, 026 | Covered |
| 4.6 Import-boundary lint preset — SIV-3 Layer A (#1529) | dependency-cruiser preset riding check_static_analysis; core→IO fixture; Layer B deferred | 027 | Covered |
| 4.7 Tier-conditional prompt + skill reframe — R7 + R8 (#1522, #1523) | Prompt scales with tier (data-driven, INV-6); five-skill reframe via skills-src + regeneration (INV-4 enforcing) | 028, 029 | Covered |

## Scope Declaration

**Target:** Full design — Phase 0 + R4 + boundary ride-alongs (#1516, #1518, #1522, #1523, #1519, #1527, #1528, #1529 Layer A, #1530)
**Excluded:** R2 (#1517) config-resolved overrides, R5 (#1520), R6 (#1521), R9 (#1524), R10 (#1525), SIV-3 Layer B, SIV-5/6/7 — deferred per design §1/§8; epic phasing preserved.
