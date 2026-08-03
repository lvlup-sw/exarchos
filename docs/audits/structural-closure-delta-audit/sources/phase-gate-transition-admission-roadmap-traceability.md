## Roadmap Traceability

### Traceability Matrix

| Design Section | Key Requirements | Task ID(s) | Status |
|----------------|-----------------|------------|--------|
| Design & Rationale | Evidence-backed admission replaces legacy edge guards | 001-053 | Covered |
| Constraints | Event sourcing, shared dispatch, shared IR, workload/platform agnosticity | 004-010, 014, 017, 023, 026, 033-053 | Covered |
| Problem Statement | Characterize mutable-state bypasses and false gate claims | 001, 027, 028 | Covered |
| Chosen Approach | Conditions, frozen requirements, evidence, decisions, atomic transition | 007-026, 039-053 | Covered |
| Runtime Semantics and Performance | Event-sourced replay, SQLite/WAL concurrency, bounded hot path | 013, 023, 035, 038, 041, 043 | Covered |
| Delivery Milestone Split | v2.12 additive proof substrate; v3.0 shared-IR cutover | 001-053 | Covered |
| MCP 2026-07-28 Contract | Total action schemas and generated CLI presentation | 023, 026, 048 | Covered |
| Requirements (DR-N) | Complete DR-1 through DR-10 coverage | 001-053 | Covered |
| Technical Design | Provider contracts and transition-admission pipeline | 007-026, 039-053 | Covered |
| Integration Points | Event store, projections, gate runner, adapters, shared TypeSpec | 004-008, 013-016, 019-026, 033-053 | Covered |
| Exploration | Decision-fixture corpus and shadow comparison | 001-003, 027-028 | Covered |
| Alternatives considered | Retire typed-guard and gate-step-only paths through migration proof | 027-053 | Covered |
| Decisions resolved during decomposition | Additive v1 contract, closed condition AST, subject scopes, diagnostic forks | 004-005, 009, 011, 021, 036, 042-053 | Covered |

### Scope Declaration

**Target:** Full design and migration across Exarchos plus the shared Strategos workflow IR.
**Excluded:** External policy engines, cryptographic signing, and remote admission evaluation.