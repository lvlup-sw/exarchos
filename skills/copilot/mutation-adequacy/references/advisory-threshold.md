# Why mutation-adequacy is advisory, and how the threshold is set

## Advisory by default

The `mutation-adequacy` dimension warns; it does not block. A sub-threshold `mutationScore` surfaces
the survivor follow-ups and lowers `passed`, but the `review → synthesize` transition still proceeds.
This is deliberate, for three reasons:

1. **A 100% score is neither expected nor required.** Some mutants are *equivalent* — they change the
   code without changing observable behavior, so no test can kill them. There is no general, cheap way
   to filter equivalent mutants (an LLM filter is a recorded non-goal for this slice), so a perfect
   score is unattainable and a hard gate at 100% would block every real PR.

2. **The backstop is a steer, not a wall.** R5 exists to guard the *relaxed* verification mix (R6) —
   the cheaper "strict types + inline invariants + one PBT + one acceptance test" default. Its job is
   to convert vacuous tests into concrete "kill this mutant" follow-ups, not to gate merges on an
   absolute number. The follow-ups are the value; the score is the trigger.

3. **The score is calibrated from observed data, not asserted a priori.** The soft default threshold
   (~40%) reflects the real-world distribution of diff-scoped mutation scores on agentic PRs. It is a
   floor that flags "these tests are probably vacuous," not a target that asserts "these tests are
   good."

## Threshold resolution order

The effective threshold is resolved per call, override beating config beating default:

1. **Explicit `threshold` arg** on the action call — always wins (a reviewer pinning a stricter bar
   for one run).
2. **Config** — `review.gates['mutation-adequacy'].params.threshold` in `.exarchos.yml`, so a project
   can calibrate the floor from its own score trend without a code change.
3. **Soft default** (~40%) — when neither is set.

## Raising severity to blocking

Severity is separate from the threshold. The dimension is advisory (warning) by default, applied via
the slice-2 ladder-gate severity mechanism (`resolveGateSeverity` / `applyLadderGateSeverity`). An
explicit `review.gates['mutation-adequacy']` override in `.exarchos.yml` can raise it to blocking for
a project that wants mutation adequacy enforced — the same mechanism slice 2 uses for the other ladder
gates. Honor the resolved severity; never hardcode "advisory" or "blocking" in the skill.

## Calibrating from the score trend (forward-looking)

Every run emits a foldable `gate.executed` carrying `mutationScore` (INV-1). R10 left-folds that event
stream into a score *trend* — the data a project uses to move its configured threshold deliberately,
rather than guessing. This slice only **emits** the foldable event; it builds no trend view. Until R10
lands, treat the soft default as the floor and lean on the survivor follow-ups, not the absolute score.
