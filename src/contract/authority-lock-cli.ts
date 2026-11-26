/**
 * Regenerates and approves `contract-authority.lock.json` from the current tree. A run of this CLI
 * is the human approval: it writes `approved: true` for each authority at its current digest or
 * version.
 *
 * Usage, from the repository root:
 *   npx tsx src/contract/authority-lock-cli.ts
 *
 * An intentional change to a frozen authority makes the verify test fail. Run this generator,
 * review the new digests, and commit the lockfile. The invariant catalog wording is a frozen input.
 * Approve a catalog change through this generator, not by a manual digest edit, so that one run
 * records both the approval and the digest.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { collectLiveAuthorities, defaultSourcePaths } from './authority-collector.js';
import { buildAuthorityLock } from './authority-pin.js';

const LOCK_NOTE =
  'PROGRAM-03 contract authority freeze (P03-01, extended by P03-02 with the ' +
  'closed `contract-surface` authority; re-approved by T-35 / DR-26 after the ' +
  'invariant catalog was re-pointed to the GOVERNING framing of INV-2 ' +
  '(contract-client equivalence by construction), INV-4 ' +
  '(standards-conformance plus thin shims), INV-7 (closed cross-process ' +
  'serialization claim, EFF-001) and INV-11 (lifecycle/placement by ' +
  'construction; spatial write confinement excluded and declared per-harness); ' +
  're-approved again after the DR-25 PRIMARY resolution landed — the CLI now ' +
  'addresses actions through the generated client ' +
  '`contract/cli/generated-client.ts`, the `cli-direct-dispatch` deviation is ' +
  'retired, and the catalog records the retirement; re-approved again under ' +
  'DR-4 after INV-17 was amended to treat a VACUOUS `outputSchema` as a ' +
  'violation rather than a pass — the catalog wording is the frozen input, so ' +
  'the amendment re-enters the freeze through this gesture; re-approved again ' +
  'under DR-0 task 049, which completed the MCP SDK v1→v2 source migration and ' +
  'removed `@modelcontextprotocol/sdk` — the `mcp-sdk` and `mcp-protocol` ' +
  'authorities now read from `@modelcontextprotocol/server`. The protocol ' +
  'VERSION is unchanged across that move, which is the freeze corroborating ' +
  "DR-0's no-wire-change claim rather than merely restating it); re-approved " +
  'again after the `servers/exarchos-mcp` package was folded into the ' +
  'repo root — the catalog cited 54 file paths inside the dissolved package, ' +
  'and a citation that resolves to nothing governs nothing. The retarget is ' +
  'MECHANICAL: every reference was mapped through the fold\'s own move table ' +
  'and verified to exist on disk, and NO invariant summary, dimension, ' +
  'enforcement mode or audit prompt changed at that fold. Re-approved again ' +
  'under #1764 DR-7 task 086, which re-pointed INV-4 from `mode: check` ' +
  'to `mode: audit` deferring to `render:guard`. The old predicate greped ' +
  '`skills/**` for `@@` and so fired on EVERY conforming regeneration — a ' +
  'blocking invariant no conforming change could satisfy. Same shape as the ' +
  'DR-4 INV-17 amendment above: the catalog wording is the frozen input, so ' +
  'the amendment re-enters the freeze through this gesture rather than around ' +
  'it). Regenerate with ' +
  '`npx tsx src/contract/authority-lock-cli.ts` after reviewing and approving ' +
  'the new authority digests, then commit this file. ' +
  'RE-APPROVED for 2.12.0-preview.4. The ONLY difference was the ' +
  '`strategos-contracts` version string: every digest — that authority\'s own content ' +
  'digest, plus `action-id-registry`, `contract-surface` and `invariant-catalog` — ' +
  'matched the live tree unchanged, so the frozen surface is byte-identical and nothing ' +
  'about the contract actually moved. WORTH FIXING AT THE ROOT: this authority\'s ' +
  '`version` is the PACKAGE version, read from package.json by the collector, so the ' +
  'freeze trips on every release whether or not the contract changed — and each trip ' +
  'costs a re-approval plus roughly eighteen red drift guards until someone performs it. ' +
  'The content digest already carries the real signal. A freeze that fires loudest when ' +
  'it has the least to say trains its readers to re-approve without looking, which is the ' +
  'opposite of what a freeze is for. ' +
  'RE-APPROVED for the effect-ledger remedy that moved two writers off the read surface. ' +
  'Unlike the preview.4 bump above, this one is a REAL surface change and the ' +
  '`action-id-registry` digest moves because the action set moved: ' +
  '`exarchos_orchestrate.reconcile_worktrees` is NEW (the reservation reclaim and the ' +
  'launch / merge reconcilers that rode `exarchos_view.ps probe:true`), and `stack_place` ' +
  'is re-parented from `exarchos_view` to `exarchos_orchestrate`. Both moves close a ' +
  'provider disagreement rather than introducing capability: every event involved — ' +
  '`worktree.orphan_detected`, `launch.executed`, `stack.position-filled` — was ALREADY ' +
  'registered to `exarchos_orchestrate` while being appended from a `exarchos_view` ' +
  'action, so the registry and the tree disagreed about who performs the effect. No event ' +
  'schema, no invariant and no wire format changed; `ps` loses its `probe` parameter and ' +
  'becomes genuinely read-only, which is the user-visible half.' +
  ' RE-APPROVED for the #1837 resolution: the `strategos-contracts` version stops being ' +
  'COMPARED and becomes recorded provenance, and its value moves from this repo\'s own ' +
  'package version to the `@lvlup-sw/strategos-contracts` dependency spec, now a real ' +
  'published contract (0.14.0, GitHub Packages). The rule is derived, not an exception ' +
  'list: a version is compared only where the authority carries NO digest. Where a digest ' +
  'exists it is the signal, and the version is the human-legible label a reviewer reads. ' +
  'For three authorities that comparison was merely redundant — their version is a ' +
  'constant inside the very source the digest covers. For `strategos-contracts` it was ' +
  'a false alarm: its two dimensions had DIFFERENT sources, so every release of this repo ' +
  'tripped the freeze with no contract having moved, costing a re-approval and a wide red ' +
  'fan-out each time. `mcp-protocol` and `mcp-sdk` carry no digest, so their version is ' +
  'still compared, and a kill probe confirms both arms still bite. The digest still covers ' +
  'the hand-written stand-in, which STAYS: the published `InvariantEntry` and `CheckNode` ' +
  'reject both live catalogs — including Strategos\'s own — so the seam cannot close until ' +
  'lvlup-sw/strategos#231 lands.' +
  ' RE-APPROVED for the settlement endpoint. Two things moved and both are real. ' +
  'The `action-id-registry` digest moves because `exarchos_orchestrate.settle` is NEW — the ' +
  'semantic plane\'s adjudication endpoint, which reads one batch of returned claims against ' +
  'the capsule pinned when the work was compiled and commits one `execution.settled` record. ' +
  'It adds capability rather than closing a disagreement, which is the opposite of the ' +
  'effect-ledger re-approval above and is why this note says so plainly: a reviewer should ' +
  'read the new action\'s contract, not just its name. And the `strategos-contracts` note ' +
  'directly above is now WRONG where it says nothing imports the package — the capsule ' +
  'contract imports it, and `settle` is that contract\'s first production consumer. The ' +
  'sentence is corrected here rather than left standing, because a freeze whose own note ' +
  'describes a tree that no longer exists is the failure mode this file keeps warning about. ' +
  'No event schema, no invariant and no wire format changed for an EXISTING action.' +
  ' RE-APPROVED for the compilation endpoint. The `action-id-registry` digest moves because ' +
  '`exarchos_orchestrate.prepare` is NEW — it compiles a feature workflow\'s outstanding ' +
  'delegation batch into a capsule, puts the capsule and the kernel definition it pins into ' +
  'content-addressed custody, and commits one reserved `workflow.prepared` record pinning the ' +
  'capsule\'s digest. Two EXISTING surfaces change with it, and a reviewer should read both: ' +
  '`settle` now adjudicates only a capsule a prepare call recorded (it takes `capsuleVersion`, ' +
  'reads the capsule back out of custody, and refuses a submitted capsule whose digest differs), ' +
  'and the capsule contract no longer carries `batchId`, which moved to the settle request in ' +
  'the preceding change. No invariant changed.' +
  ' RE-APPROVED for the INV-3 edit. The `invariant-catalog` digest moves because INV-3 no ' +
  'longer names the remote-MCP skeleton. Reed decided on 2026-10-23 to delete it before its ' +
  'RESERVED expiry of 2026-10-31. INV-3 keeps its other references, and no other invariant changed.' +
  ' RE-APPROVED for S7 T12 by the delegated Codex coordinator under Reed\'s authorized ' +
  'project decision: read_prepared_capsule is the sole added ActionId. It reads bounded ' +
  'historical prepared custody with no writes. All other authority pins remain unchanged.' +
  ' RE-APPROVED by Reed for the Cursor security rollup (#2248, ReDoS in the conformance gate). ' +
  'The `strategos-contracts` digest moves because `invariant-schema.ts` now validates check ' +
  'leaves: a `pattern` must compile with the linear-time RE2 engine (re2js) inside the ' +
  '`check-pattern.ts` size limits, and a `fileGlob` has a length limit. RE2 has no lookaround ' +
  'and no backreference, so a catalog pattern that uses either no longer loads. No shipped ' +
  'catalog uses them. The schema shape, every field name, the action set and the wire format ' +
  'are unchanged.' +
  ' RE-APPROVED for #1928 S2 T-23 under the slice plan that Reed approved: ' +
  'exarchos_orchestrate.mutation-adequacy is the sole removed ActionId. The closed ' +
  'retired-action table refuses a call of it before dispatch, with the code ' +
  'MUTATION_TESTING_RETIRED. All other authority pins remain unchanged.' +
  ' RE-APPROVED for the retirement of the source-revert kill probe under Reed\'s decision of ' +
  '2026-11-25: exarchos_orchestrate.check_test_adequacy is the sole removed ActionId. The closed ' +
  'retired-action table refuses a call of it before dispatch, with the code TEST_ADEQUACY_RETIRED. ' +
  'All other authority pins remain unchanged.' +
  ' RE-APPROVED for #1928 S3 T-27 under the slice plan that Reed approved, for Reed ' +
  're-approval at the pull request: the `invariant-catalog` digest moves because INV-11 ' +
  'names no launcher. Process lifecycle and worktree placement belong to the harness, the ' +
  'audit prompt flags a claim that Exarchos owns them, and the reference to the launcher ' +
  'worktree module is removed. No ActionId, event schema or other invariant changed.' +
  ' RE-APPROVED for #1928 S4 T-29 under the slice plan that Reed approved, for Reed ' +
  're-approval at the pull request: exarchos_orchestrate.create_pr, merge_pr, ' +
  'add_pr_comment and create_issue are the removed ActionIds. The closed retired-action ' +
  'table refuses a call of each before dispatch, with the code PROVIDER_WRITE_RETIRED. ' +
  'All other authority pins remain unchanged.' +
  ' RE-APPROVED for #1928 S4 T-31 under the slice plan that Reed approved, for Reed ' +
  're-approval at the pull request: exarchos_orchestrate.check_ci, list_prs and ' +
  'get_pr_comments are the removed ActionIds. The closed retired-action table refuses a ' +
  'call of each before dispatch, with the code PROVIDER_READ_RETIRED. All other authority ' +
  'pins remain unchanged.' +
  ' RE-APPROVED for #1928 S4 T-32 under the slice plan that Reed approved, for Reed ' +
  're-approval at the pull request: exarchos_orchestrate.check_pr_comments, check_coderabbit ' +
  'and validate_pr_stack are the removed ActionIds. The closed retired-action table refuses a ' +
  'call of each before dispatch, with the code PROVIDER_READ_RETIRED. All other authority ' +
  'pins remain unchanged.' +
  ' RE-APPROVED for #1928 S4 T-33 under the slice plan that Reed approved, for Reed ' +
  're-approval at the pull request: exarchos_orchestrate.assess_stack is the removed ActionId. ' +
  'The closed retired-action table refuses a call of it before dispatch, with the code ' +
  'PROVIDER_READ_RETIRED. All other authority pins remain unchanged.' +
  ' RE-APPROVED for #1928 S5 T-35 under the slice plan that Reed approved, for Reed ' +
  're-approval at the pull request: exarchos_orchestrate.setup_worktree and prune_worktrees ' +
  'are the removed ActionIds. The closed retired-action table refuses a call of each before ' +
  'dispatch, with the code PROVIDER_WRITE_RETIRED and a message that names the harness. All ' +
  'other authority pins remain unchanged.' +
  ' RE-APPROVED for #1928 S5 T-36 under the slice plan that Reed approved, for Reed ' +
  're-approval at the pull request: exarchos_orchestrate.merge_orchestrate and serialize_merge ' +
  'are the removed ActionIds, and the merge-orchestrate top-level verb leaves the CLI. The closed ' +
  'retired-action table refuses a call of each before dispatch, with the code ' +
  'PROVIDER_WRITE_RETIRED and a message that names the harness landing. The ' +
  '`invariant-catalog` digest moves because INV-10, INV-13 and INV-14 no longer reference the ' +
  'deleted merge orchestrator module: INV-10 references the liveness registry, INV-13 keeps the ' +
  'atomic appender, and INV-14 references the recovery runbook of the merge-orchestrator skill. ' +
  'No invariant summary, dimension, enforcement mode or audit prompt changed. All other ' +
  'authority pins remain unchanged.' +
  ' RE-APPROVED for #1928 S5 under Reed\'s decision of 2026-11-25 to delete the worktree ' +
  'lifecycle manager, pre-approved for the authority lock: exarchos_orchestrate.acquire_worktree, ' +
  'release_worktree and reconcile_worktrees are the removed ActionIds. The closed retired-action ' +
  'table refuses a call of each before dispatch, with the code PROVIDER_WRITE_RETIRED and the ' +
  'worktree provisioning message that names the harness. All other authority pins remain unchanged.';

/**
 * The approver that the freeze records for the current snapshot. Change it at each new approval, so
 * the lockfile records who approved and not the tool.
 */
export const CURRENT_APPROVER =
  'Delegated Claude worker (#1928 S5 worktree lifecycle manager deletion under Reed\'s decision ' +
  'of 2026-11-25, pre-approved for the authority lock; for Reed review at the pull request). ' +
  'Previously: ' +
  'Delegated Claude worker (#1928 S5 T-36 local merge retirement under the slice plan that ' +
  'Reed approved, 2026-11-23; for Reed re-approval at the pull request). Previously: ' +
  'Delegated Claude worker (#1928 S5 T-35 worktree provisioning retirement under the slice ' +
  'plan that Reed approved, 2026-11-23; for Reed re-approval at the pull request). Previously: ' +
  'Delegated Claude worker (#1928 S4 T-33 stack assessment retirement under the slice plan ' +
  'that Reed approved, 2026-11-23; for Reed re-approval at the pull request). Previously: ' +
  'Delegated Claude worker (#1928 S4 T-32 provider review and stack read retirement under the ' +
  'slice plan that Reed approved, 2026-11-23; for Reed re-approval at the pull request). ' +
  'Previously: ' +
  'Delegated Claude worker (#1928 S4 T-31 provider read retirement under the slice plan ' +
  'that Reed approved, 2026-11-23; for Reed re-approval at the pull request). Previously: ' +
  'Delegated Claude worker (#1928 S4 T-29 provider writer retirement under the slice plan ' +
  'that Reed approved, 2026-11-23; for Reed re-approval at the pull request). Previously: ' +
  'Delegated Claude worker (#1928 S3 T-27 launcher retirement: INV-11 re-pointed away from ' +
  'the launcher under the slice plan that Reed approved, 2026-11-23; for Reed re-approval at ' +
  'the pull request). Previously: ' +
  'Delegated Claude worker (#1928 S2 check_test_adequacy retirement under Reed\'s decision of ' +
  '2026-11-25, pre-approved for the authority lock; for Reed review at the pull request). Previously: ' +
  'Delegated Claude worker (#1928 S2 T-23 mutation-adequacy retirement under the slice plan ' +
  'that Reed approved, 2026-11-23; for Reed review at the pull request). Previously: ' +
  'Reed (re-approved for the invariant-schema change in the Cursor security rollup: check ' +
  'patterns must compile with RE2 and globs have a length limit; decision of 2026-11-23). ' +
  'Previously: Delegated Codex coordinator (S7 T12 action introduction reviewed under Reed\'s authorized ' +
  'project decision, 2026-11-14). Previously: ' +
  'Reed (re-approved for the INV-3 edit: the reference to the deleted remote-MCP skeleton ' +
  'removed; decision of 2026-10-23). Previously: ' +
  'Reed (re-approved for the compilation endpoint: exarchos_orchestrate.prepare added, ' +
  'workflow.prepared reserved, and settle narrowed to prepared capsules; decision recorded on ' +
  'their instruction). Previously: Reed (re-approved for the settlement endpoint: ' +
  'exarchos_orchestrate.settle added, and the stale "nothing imports strategos-contracts" ' +
  'sentence in the note corrected; decision recorded on their instruction)';

export function regenerateAuthorityLock(approvedBy = CURRENT_APPROVER): string {
  const paths = defaultSourcePaths();
  const live = collectLiveAuthorities(paths);
  const lock = buildAuthorityLock(live, { approvedBy, note: LOCK_NOTE });
  const serialized = JSON.stringify(lock, null, 2) + '\n';
  fs.writeFileSync(paths.lockFile, serialized, 'utf8');
  return paths.lockFile;
}

/** True only on direct invocation, so an import of this module has no side effect. */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const written = regenerateAuthorityLock();
  process.stdout.write(`wrote approved authority lock: ${written}\n`);
}
