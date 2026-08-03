# Structural Closure Audit Package

This directory is the canonical package for the structural-closure program.

## Start here

1. [`unified-remediation-plan.md`](./unified-remediation-plan.md) - the single
   implementation sequence. It merges the audit backlog, phase-gate admission
   design, dogfood remediation, structural-principles analysis, and API contract
   compiler design.
2. [`2026-07-23-structural-closure-delta-audit.md`](./2026-07-23-structural-closure-delta-audit.md)
   - the evidence report supporting the plan.
3. [`remediation-backlog.json`](./remediation-backlog.json) - detailed
   implementation evidence, target files, dependencies, and acceptance proofs.
4. [`api-contract-codegen.json`](./api-contract-codegen.json) - the full target
   contract/compiler architecture.

The unified plan is authoritative for sequencing. The report and JSON files are
evidence and detailed requirements; the files under `sources/` preserve the
analysis and designs that were merged into the plan.

## Package layout

| Path | Purpose |
|---|---|
| `unified-remediation-plan.md` | Canonical program and dependency plan |
| `2026-07-23-structural-closure-delta-audit.md` | Current-state structural evidence |
| `manifest.json` | Package inventory, provenance, and digests |
| `contracts.json` | Contract and public-surface inventory |
| `effects.json` | Effect ownership and occurrence inventory |
| `ship-surface.json` | Action-to-handler-to-effect-to-proof graph |
| `artifacts.json` | Build, release, install, cache, and generated-artifact inventory |
| `v3-lowering.json` | Workflow/IR and runtime disposition inventory |
| `codebase-metrics.json` | Repository and native-gate measurements |
| `remediation-backlog.json` | Detailed audit findings and acceptance proofs |
| `api-contract-codegen.json` | MCP-to-Exarchos contract compiler specification |
| `sources/` | Reports, analysis, principles, and design inputs |
| `implementation/` | Reconstructable phase-gate proof-substrate handoff |

## Authority rule

Source documents may contain overlapping task lists, release labels, or local
sequencing. Those lists are retained for design depth and traceability, but they
do not create parallel plans. Work is selected and ordered only through
`unified-remediation-plan.md`.
