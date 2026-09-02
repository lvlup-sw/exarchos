# Pinned workflow binary — DEFERRED

**Status:** deferred, blocked on a release. **Not** silently skipped.

## What this was for

This repository runs its own workflow engine on itself while that engine's source is being
moved. The mitigation is to pin a pre-refactor `exarchos` binary and drive the refactor with
it, so the tool doing the work is never the tree being changed. Without the pin, a mid-flight
breakage in the moved source becomes an outage of the thing performing the move — and the
recovery path runs through the same broken tool.

## Why it is not pinned yet

The binary that would be pinned has to contain the current work. The installed build predates
the WFQ-006 gate fix, so pinning it would drive every local gate through stale logic — the
opposite of the safety this task is trying to buy. Building from the working tree is not a fix
either: an unreleased local build is not reproducible by anyone else, which is most of what a
pin is for.

So the pin depends on this branch merging and a release being cut. That is a release-cadence
decision, and it is the author's call rather than something this task can force.

## What this means for the phases

Phase 0 is safe without the pin. Nothing in it moves product source: the oracles write only to
`tools/audit/` and `tests/architecture/`, the dead-declaration removal touches `package.json`,
and the artifact-directory change is additive and covered by its own characterization tests.
The engine keeps running on unmoved code throughout.

**Phase 1 is where the pin becomes load-bearing**, because that is where the engine's own
source relocates. Entering Phase 1 without a pinned binary means accepting that a bad move can
disable the tool mid-refactor.

## The gate

Before Phase 1 begins:

1. Merge this branch.
2. Cut a release.
3. Install that build, record its version and resolved path here.
4. Re-run the Phase 0 oracles against it, so the pinned tool is known to agree with the
   baselines it will be checked against.

Until step 3 is recorded, this file states the deferral rather than implying a pin exists.
An absent pin that looks present is worse than an obvious gap.

## Benchmark baseline

The other half of this task did complete: `tools/audit/benchmark-baseline.json` records nine
benchmarks with per-benchmark noise bands derived from each one's own measured relative margin
of error. It does not depend on the pin.
