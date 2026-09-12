// ─── Authority lock generator / approval tool (P03-01) ───────────────────────
//
// Regenerates and APPROVES `contract-authority.lock.json` from the current
// tree. Running this CLI is the human approval gesture: it writes a lock with
// `approved: true` for every authority at its current digest/version.
//
// Usage (from the repository root):
//   npx tsx src/contract/authority-lock-cli.ts
//
// After ANY intentional change to a frozen authority (schema module, invariant
// catalog, ActionId set, compatibility policy, MCP protocol/SDK version), the
// verify test goes red; re-run this generator to review + approve the new
// digests, then commit the updated lockfile.
//
// T-35 / DR-26 — the invariant catalog is one of those frozen authorities, and
// its WORDING is a load-bearing input to generation: a stale framing in
// `.exarchos/invariants.md` propagates into every generated artifact that
// builds against the freeze. Re-approving the catalog therefore means running
// THIS generator (never hand-editing a digest) so the recorded approval and the
// recorded digest are produced by the same gesture.
// ────────────────────────────────────────────────────────────────────────────

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
  'No event schema, no invariant and no wire format changed for an EXISTING action.';

/**
 * Who/what the freeze records as the approver of the CURRENT snapshot. Bump
 * this when a new work package performs the review-and-approve gesture, so the
 * lockfile carries the provenance of the approval rather than of the tool.
 */
export const CURRENT_APPROVER =
  'Reed (re-approved for the settlement endpoint: exarchos_orchestrate.settle added, and the ' +
  'stale "nothing imports strategos-contracts" sentence in the note corrected; decision ' +
  'recorded on their instruction). Previously: Reed (#1837 resolution: version compared only ' +
  'where no digest exists, strategos-contracts version re-pointed at the dependency spec)';

export function regenerateAuthorityLock(approvedBy = CURRENT_APPROVER): string {
  const paths = defaultSourcePaths();
  const live = collectLiveAuthorities(paths);
  const lock = buildAuthorityLock(live, { approvedBy, note: LOCK_NOTE });
  const serialized = JSON.stringify(lock, null, 2) + '\n';
  fs.writeFileSync(paths.lockFile, serialized, 'utf8');
  return paths.lockFile;
}

// Executed only when run directly (never on import), so importing this module
// for `regenerateAuthorityLock` in a test has no side effect.
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
