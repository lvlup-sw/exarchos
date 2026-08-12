## Spec Traceability

Requirement → task coverage for the onboard/doctor consolidation epic (#1510,
closes #1508). The design-requirement (`DR-*`) rows are reconstructed from each
task's `**Implements:**` annotation in
[`2026-06-06-onboard-doctor-consolidation.md`](2026-06-06-onboard-doctor-consolidation.md)
(the authoritative per-task mapping). All ten DRs shipped via PR #1534; the
non-DR rows are narrative design context, not separately-tracked requirements.

### Traceability Matrix

| Design Section | Key Requirements | Task ID(s) | Status |
|----------------|-----------------|------------|--------|
| Problem Statement | Four overlapping first-run verbs (`init`, `install-skills`, `new-project`, `doctor`) duplicated writers/detection | — | Narrative |
| Chosen Approach | Option 1 — hard replace over one shared reconciler | 004–020 | Covered |
| Approaches Considered | Options 1–3 weighed | — | Narrative |
| Option 1: Hard replace over one reconciler (CHOSEN) | Single reconciler core; `onboard` + `doctor` facades | 004–020 | Covered |
| Option 2: Compose + deprecate (keep `init`/`install-skills` aliases) | Rejected | — | Not pursued |
| Option 3: Keep four verbs, only dedupe the writers | Rejected | — | Not pursued |
| Requirements | DR-1…DR-10 (full scope) | 001–020 + fix-1 | Covered |
| DR-1: Shared reconciler core (INV-2 facade) | Pure detect→diff→apply→events core behind both facades | 004, 005, 006, 007, 009 | Covered |
| DR-2: `onboard` verb — adopt an existing repo | onboard pipeline handler + CLI/registry wiring + install step | 010, 011, 015 | Covered |
| DR-3: `onboard --new <name>` greenfield + retire `new-project` | Single-pipeline greenfield scaffold; delete `new-project` (#1508) | 016, 017 | Covered |
| DR-4: `doctor --fix` over the shared `apply` (INV-5b) | `diff` from doctor checks; `--fix` routes through shared reconciler | 006, 013 | Covered |
| DR-5: Remove `init` / `install-skills`; one-release error stubs | Remove verbs/actions; rename error stubs; migration sweep | 011, 018, 020 | Covered |
| DR-6: CLI/MCP parity split — install CLI-only with MCP advisory (INV-2/INV-3) | Surface gate downgrades cli-only install to an advisory off-CLI | 014, 015 | Covered |
| DR-7: Event contract — `onboard.requested` + `onboard.executed` (INV-1 / INV-13) | Two-event schema + split + crash recovery | 008, 009 | Covered |
| DR-8: SessionStart hook installation — default on (#1485) | Default-on hook step + `session-start-hook` doctor check | 012 | Covered |
| DR-9: Characterization baseline (Feathers) — guard the fold | Characterize `init` / `doctor` / `install-skills` / `new-project` outputs | 001, 002, 003 | Covered |
| DR-10: Error handling, failure modes, and edge cases | Forward-only apply; failure-mode hardening | 007, 009, 014, 019 | Covered |
| Technical Design | Reconciler module + facades + event seam | 004–015 | Covered |
| Integration Points | Registry, CLI adapters, doctor checks, event store | 008, 011, 012, 014 | Covered |
| Testing Strategy | TDD per task; characterization guard; parity + failure-mode suites | 001–020 | Covered |
| Open Questions | Resolved during execution (see plan §Open Questions) | — | Resolved |

### Scope Declaration

**Target:** Consolidate `init` + `install-skills` + `new-project` + `doctor` into
an `onboard` + `doctor` pair over one shared, harness-neutral reconciler
(`dispatch/core/onboarding/reconcile.ts`), delivered across tasks 001–020 plus the
review-fix follow-up (epic #1510; closes #1508).

**Excluded:** Backward-compatible aliases beyond the one-release error stubs
(DR-5); any server-side / MCP-surface skills-or-deps install (install is
CLI-only with an advisory off-CLI, DR-6); the retired `new-project` `CLAUDE.md`
template copy and `applyLanguageCustomizations` npm rewrite (commands come from
the layered resolver, INV-6, DR-3/task 017).
