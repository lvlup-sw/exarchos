/**
 * Comments this policy must reject, copied VERBATIM from the tree.
 *
 * Invented offenders prove only that a pattern matches what it was written
 * against. These were measured, so each one is a case the tree actually
 * contains and a rule that stops catching it has regressed against reality.
 *
 * Every consumer runs this same corpus, so the gate and the ESLint rule cannot
 * quietly disagree about what a violation is.
 *
 * The directory is listed in the policy's exemptPaths — a guard that flagged
 * its own kill fixtures could not be tested.
 */

// Source: src/workflow/tools.ts:52
// T034 (DR-6) — checkpoint materializes the rehydration projection:
// fold events → snapshot → emit `workflow.checkpoint_written`. Reuses the
// helper extracted in T031 so the hydrate path is identical to the one the
// rehydrate handler exercises.
export const checkpointMaterializes = true;

// Source: src/next-actions-computer.test.ts:204
// ─── Task 008 (#1581 DR-4): post-collapse affordance integrity (INV-12) ──────
export const affordanceIntegrity = true;

// Source: src/utils/atomic-write.ts:313
//
// As committed. This comment STATES ITS CONSTRAINT and would survive the rule
// on its content alone — it is an offender only because it opens with a bare
// ordinal. Its ordinal-stripped rewrite is the counter-case in permitted.ts,
// and the pair is the whole argument for judged rewriting over bulk deletion:
// mechanical stripping would take the reasoning with the identifier.
// DR-16: the bytes were fsync'd before the rename; the NAME is durable
// only once the parent directory is fsync'd too. Strictly after the
// rename — fsync'ing the directory first would prove nothing about an
// entry that does not exist yet, and a publish that never renamed must
// not claim a durable entry at all.
export const durableRename = true;

// Source: src/architecture/layer-boundaries-seam.ts (shape)
// Verification-ladder slice 1 (task 017): contracts are per-toolchain
export const perToolchainContracts = true;

// Source: scripts/guard-inventory.ts:9 (shape)
// dominant risk, and Wave 1 accumulated instances of it faster than anything
export const waveOneRisk = true;

// Source: src/event-store/event-annotations.ts:161 (shape)
// DR-13 (epic #1546) resolve-then-freeze: `phase.entered` freezes the resolved
export const resolveThenFreeze = true;

// Source: scripts/check-measured-premises.mjs:2 (shape)
// Every numeric and structural claim in `docs/specs/2026-08-06-internal-mechanics-overhaul.md`
export const measuredPremises = true;

// A changelog narration the policy rejects on the measured tree.
// this used to be a map
export const wasAMap = true;

// formerly the CLI owned this
export const cliOwned = true;

// Previously this used a hardcoded `.exarchos/state/...` fallback that
export const hardcodedFallback = true;
