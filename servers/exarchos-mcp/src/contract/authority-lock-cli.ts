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
// ────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { collectLiveAuthorities, defaultSourcePaths } from './authority-collector.js';
import { buildAuthorityLock } from './authority-pin.js';

const LOCK_NOTE =
  'PROGRAM-03 contract authority freeze (P03-01). Regenerate with ' +
  '`npx tsx src/contract/authority-lock-cli.ts` after reviewing and approving ' +
  'the new authority digests, then commit this file.';

export function regenerateAuthorityLock(approvedBy = 'P03-01'): string {
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
