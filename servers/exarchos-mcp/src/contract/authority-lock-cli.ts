// ─── Authority lock generator / approval tool (P03-01) ───────────────────────
//
// Regenerates and APPROVES `contract-authority.lock.json` from the current
// tree. Running this CLI is the human approval gesture: it writes a lock with
// `approved: true` for every authority at its current digest/version.
//
// Usage (from servers/exarchos-mcp):
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
  'retired, and the catalog records the retirement). Regenerate with ' +
  '`npx tsx src/contract/authority-lock-cli.ts` after reviewing and approving ' +
  'the new authority digests, then commit this file.';

/**
 * Who/what the freeze records as the approver of the CURRENT snapshot. Bump
 * this when a new work package performs the review-and-approve gesture, so the
 * lockfile carries the provenance of the approval rather than of the tool.
 */
export const CURRENT_APPROVER = 'wiring-closure (DR-25 primary resolution)';

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
