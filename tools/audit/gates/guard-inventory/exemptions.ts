export type ExemptedFinding =
  | 'unreachable'
  | 'filtered-implementation-surface'
  | 'filename-coupled-entrypoint';

export interface GuardExemption {
  /** Repo-relative path of the guard whose hosting is knowingly imperfect. */
  readonly artifact: string;
  /**
   * Which finding this entry excuses. Naming it means an exemption written for a
   * wiring gap cannot silently also cover a two-surface violation that appears
   * later — each imperfection is justified on its own terms.
   */
  readonly excuses: ExemptedFinding;
  /** Why it cannot be fixed yet. Must name the blocking work. */
  readonly reason: string;
  /** The task or issue that unblocks it. */
  readonly blockedBy: string;
  /** ISO `YYYY-MM-DD`. Past this date the exemption FAILS rather than lapsing quietly. */
  readonly expires: string;
}

/**
 * The recorded, EXPIRING reasons a Wave-1 guard is not reachable from CI.
 *
 * DR-24 permits exactly this and nothing looser: "every guard is reachable from a
 * CI job — or carries a recorded, expiring reason why not." An entry here is a
 * debt with an owner and a deadline, never a permanent exemption; see
 * {@link auditGuardInventory} for the four ways an entry can fail.
 */
export const GUARD_EXEMPTIONS: readonly GuardExemption[] = Object.freeze([
  // DISCHARGED by task 064 — entry removed rather than re-dated.
  //
  // `tools/audit/gates/validate-plugin.sh` now runs as a blocking, unfiltered step in
  // ci.yml's `grep-gates` job (plus a DR-10 `.test.sh` re-assert), so it no
  // longer exhibits `unreachable` and `auditGuardInventory` would flag a
  // surviving entry as `[stale-exemption]`. That tooth is what forced this
  // deletion, and it is the mechanism working as designed.
  //
  // Two numbers this entry carried were WRONG when measured on the landing
  // branch on 2026-08-07, and both came from the spec's Task 064 prose rather
  // than from a derivation — the DR-27 class, in the file that inventories
  // DR-24. Recorded here so the correction is not lost with the entry:
  //   - the `validate` chain was NINE steps, not seventeen;
  //   - `validate-plugin.sh` failed FIVE of nine checks (four passed), and from
  //     FOUR distinct causes, not three: the entry omitted `.claude-plugin/
  //     plugin.json` missing a `hooks` field.
  // All four causes turned out to be the GATE being stale, not the package —
  // each contradicted a green assertion in `src/install/plugin-validation.test.ts`.
  // NARROWED by task 023, not discharged. This entry named task 023 as its
  // blocker on the reasoning that populating the allowlist would make the gate
  // green. Task 023 landed and the reasoning turned out to be incomplete, so the
  // correction is recorded here rather than the entry being re-dated:
  //
  //   Ten of the eleven literals are now tracked debt with an owner and an
  //   ENFORCED deadline, and the ratchet half is wired blocking and unfiltered
  //   (`cli-derivation-ratchet-guard.ts`, which this inventory reports as
  //   `enforcement: blocks`, `pathFilteredOnly: false`). What remains is ONE
  //   violation — `merge-orchestrate`, the DR-5 kill fixture. It is not
  //   allowlistable: `readPolicy` refuses a policy file that names it, because
  //   an earlier revision exempted it and thereby neutralized the rejection DR-5
  //   requires. DR-5's stated remediation is to DELETE the hand-written
  //   `.command('merge-orchestrate')` call and let the registry declaration be
  //   the single remaining definition — and NO Wave-1 task owns that edit. Task
  //   023's `**Files:**` list does not include the composition root, and
  //   removing a promoted top-level verb is a user-visible surface change that
  //   the `init` / `install-skills` precedent says needs a rename stub, i.e. a
  //   decision rather than a guard task.
  //
  // DISCHARGED by task 076 — entry removed rather than re-dated.
  //
  // The entry above recorded that the derivation entrypoint stayed unwired
  // because ONE violation survived task 023's paydown: `merge-orchestrate` was
  // declared both as a registry action and by hand in the composition root, and
  // as the DR-5 kill fixture it could not be allowlisted around. It named the
  // unblocking edit ("delete the hand-written call") and noted the edit was
  // unowned by any Wave-1 task.
  //
  // Task 076 made that edit, and the resolution was cheaper than the entry
  // assumed. The entry reasoned that deleting a promoted top-level verb is a
  // user-visible surface change needing an `init`-style rename stub — a decision
  // rather than a guard task. That premise was WRONG, and the correction is
  // recorded here rather than lost with the entry: DR-7 had already shipped
  // `CliActionHints.topLevel`, a registry hint whose hoist loop registers a
  // top-level command through `registerActionCommand`. Moving the promotion onto
  // that hint deletes the hand-written literal while keeping `exarchos
  // merge-orchestrate …` byte-identical for operators. No rename stub was owed,
  // because nothing was renamed — only the place the name is DECLARED moved.
  //
  // The derivation entrypoint is now wired direct and blocking on the unfiltered
  // `grep-gates` deps tail (the host class this entry itself specified), so it
  // no longer exhibits `unreachable` and `auditGuardInventory` would flag a
  // surviving entry as `[stale-exemption]`. That tooth is what forced this
  // deletion, and it is the mechanism working as designed.
  // DISCHARGED by task 036 — both `filtered-implementation-surface` entries
  // removed rather than re-dated.
  //
  // `lint-inv6.mjs` and `lint-test-first-drift.mjs` both ran via `npm run
  // skills:guard` in the `root`-filtered `test-root` job while their own
  // sources sat under `scripts/**`, outside that filter — so a PR that weakened
  // either lint never armed the only job that runs it. Both entries recorded
  // the same unblocking edit and rejected it for the same reason: widening
  // `root` to `scripts/**` would also arm `test-windows-root`, a lane never
  // proven green on main (#1699).
  //
  // Task 036 dissolved `scripts/` into `tools/`, and the filter now names
  // `tools/**` — so the sources moved INSIDE the filter without anyone widening
  // it to reach them. The #1699 trade was never re-made; it was made moot. Both
  // lints are now armed by edits to their own source, `auditGuardInventory`
  // reports neither as `filtered-implementation-surface`, and a surviving entry
  // would be flagged `[stale-exemption]` — which is what forced this deletion.
]);

// ─── The inventory ───────────────────────────────────────────────────────────
