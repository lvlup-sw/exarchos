# Phase-Gate Proof-Substrate Implementation Handoff

This directory contains the reconstructable implementation handoff supplied in
`sol-research.zip`.

| File | Purpose |
|---|---|
| `METADATA.json` | Repository, branch, base, head, and handoff metadata |
| `SHA256SUMS.txt` | Original handoff checksums |
| `phase-gate-v212-proof-substrate.bundle` | Git bundle containing the implementation branch |
| `phase-gate-v212-proof-substrate.diff` | Unified implementation diff |

The original archive also contains a full source snapshot. It remains in the
repository-root `sol-research.zip` to avoid duplicating an entire repository
snapshot inside the audit package. The bundle and diff are sufficient to inspect
or reconstruct the implementation against the base named in `METADATA.json`.

The implementation contributes concrete module boundaries, event schemas,
evidence types, gate-runner ownership, phase-attempt identity, idempotency,
authorization, reliability projection, supersession, contradiction, and
cancellation-process-manager designs to the unified plan. It does not create a
separate execution sequence.
