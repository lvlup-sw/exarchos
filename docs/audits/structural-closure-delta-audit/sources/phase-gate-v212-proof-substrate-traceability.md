## Spec Traceability

### Traceability Matrix

| Design Section | Key Requirements | Task ID(s) | Status |
|----------------|-----------------|------------|--------|
| Design & Rationale | Additive trusted proof substrate with unchanged transition behavior | 001-017 | Covered |
| Constraints | Event sourcing, SQLite serialization, idempotency, HSM authority, trusted capabilities | 003, 006, 011-017 | Covered |
| Problem Statement | Establish replayable proof before the deferred v3.0 enforcement cutover | 001-017 | Covered |
| Chosen Approach | Versioned evidence, trusted identity, canonical runner, audit/shadow posture | 002-017 | Covered |
| Requirements (DR-N) | Complete DR-1 through DR-7 coverage | 001-017 | Covered |
| Technical Design | Dispatch context to provider, runner, durable evidence, projections, and recovery | 002-017 | Covered |
| Integration Points | Event store, workflow, dispatch, adapters, orchestrate, views, and census | 003, 006-017 | Covered |
| Alternatives considered | Preserve the milestone split and reject temporary policy registries | 001, 008-009, 015 | Covered |
| Open Questions | Shared IR and public admission actions are explicitly deferred to v3.0 | N/A | Deferred |

### Scope Declaration

**Target:** Complete v2.12 additive proof substrate in audit/shadow posture.
**Excluded:** Shared IR, admission evaluation, public schemas, strict enforcement, built-in cutover, and legacy deletion.