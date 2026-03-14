# Assay Plugin Integration

How the exarchos quality review phase delegates general backend quality checks to the assay plugin while retaining domain-specific checks.

## Architecture

```text
/exarchos:review (quality-review stage)
    │
    ├── Invoke assay:audit (general backend quality)
    │   └── Returns: findings[] + verdict (CLEAN | NEEDS_ATTENTION)
    │
    ├── Run exarchos-specific checks (not in assay)
    │   ├── D1: Spec Fidelity & TDD traceability
    │   ├── D2-domain: Event Sourcing / CQRS / HSM / Saga invariants
    │   ├── D3: Context Economy & Token Efficiency
    │   └── D5: Workflow Determinism
    │
    ├── Merge findings (assay + exarchos-specific)
    │
    ├── Compute verdict
    │   ├── BLOCKED: any HIGH violates append-only, state derivability, or terminal reachability
    │   ├── NEEDS_FIXES: any HIGH or MEDIUM_count > 5
    │   └── APPROVED: everything else
    │
    ├── Emit workflow events (gate.executed)
    └── Transition phase
```

## Dimension Ownership Split

| Concern | Owner | Rationale |
|---------|-------|-----------|
| DIM-1: Topology | Assay plugin | General backend quality |
| DIM-2: Observability | Assay plugin | General backend quality |
| DIM-3: Contracts | Assay plugin | General backend quality |
| DIM-4: Test Fidelity | Assay plugin | General backend quality |
| DIM-5: Hygiene | Assay plugin | General backend quality |
| DIM-6: Architecture | Assay plugin | General backend quality |
| DIM-7: Resilience | Assay plugin | General backend quality |
| D1: Spec Fidelity & TDD | Exarchos | Requires workflow state (design → plan → implementation traceability) |
| D2-domain: Event Sourcing / CQRS / HSM / Saga | Exarchos | Domain-specific to event-sourced systems |
| D3: Context Economy | Exarchos | Specific to AI-agent skill systems |
| D5: Workflow Determinism | Exarchos | Specific to workflow orchestration |

## Invoking Assay from Quality Review

During the quality review stage, after spec-review passes:

1. **Run assay:audit** for the feature scope (diff files):
   ```text
   assay:audit --scope [changed files from diff]
   ```

2. **Translate assay findings** to exarchos finding format:
   - Assay `dimension` → map to exarchos dimension (DIM-1 → general-topology, etc.)
   - Assay `severity` → same tiers (HIGH, MEDIUM, LOW)
   - Assay `evidence` → same format (file:line)

3. **Run exarchos-specific checks** (existing orchestrate actions):
   - `check_security_scan` (D1 gate)
   - `check_static_analysis` (D2 gate)
   - `check_context_economy` (D3 gate)
   - `check_workflow_determinism` (D5 gate)

4. **Merge findings** from both sources

5. **Compute verdict** using `check_review_verdict`

## Verdict Mapping

| Assay Verdict | Exarchos-Specific Findings | Combined Verdict |
|--------------|---------------------------|-----------------|
| CLEAN | None | APPROVED |
| CLEAN | MEDIUM only | NEEDS_FIXES |
| CLEAN | Any HIGH | NEEDS_FIXES or BLOCKED |
| NEEDS_ATTENTION | None | NEEDS_FIXES |
| NEEDS_ATTENTION | Any | NEEDS_FIXES or BLOCKED |

## Migration Path

### Phase 1 (Complete): Coexistence
- Assay plugin created in exarchos repo under `assay/` with 45 structural validation tests
- 6 composable skills: scan, critique, harden, distill, verify, audit
- Shipped in #1023

### Phase 2 (Current): Delegation
- Assay extracted to standalone repo: [lvlup-sw/assay](https://github.com/lvlup-sw/assay)
- Install independently: `claude plugin add lvlup-sw/assay`
- Quality review delegates general checks to assay:audit
- Exarchos-specific checks remain in the quality-review skill
- Existing orchestrate actions (check_static_analysis, etc.) become the thin layer
- Extracted in #1025

### Phase 3 (Future): Full Integration
- Feature-audit skill deprecated and removed
- Quality review is purely: assay:audit + exarchos-specific checks + verdict
- Convergence dimensions map cleanly to assay dimensions + exarchos dimensions
