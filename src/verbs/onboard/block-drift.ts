/**
 * On-ramp block drift check (Task 013, DR-5).
 *
 * Read-only `doctor` finding: does the Exarchos on-ramp block installed in the
 * consumer's `AGENTS.md` still match the canonical `binding/standard/block.md`?
 * The comparison is a content-hash diff of the fence-stripped block body against
 * a freshly-computed hash of the canonical body — so a provenance-line change
 * (metadata) never registers as drift, but any change to the orientation prose
 * does. The canonical body has one source of truth (`binding/standard/block.md`,
 * loaded via {@link loadCanonicalBlockBody}); this check never carries a second
 * copy of the block content.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';

import type { CheckResult } from '../doctor/schema.js';
import { toPosix } from '../../utils/paths.js';
import {
  AGENTS_MD_FILENAME,
  loadCanonicalBlockBody,
  stripBindingFences,
} from '../init/writers/onramp-block.js';

/** The doctor check name for the on-ramp block drift finding. */
export const BLOCK_DRIFT_CHECK_NAME = 'onramp-block-drift';

/** 16-hex sha256 prefix of the normalized (LF, trimmed) body — the drift key. */
function bodyHash(body: string): string {
  return crypto
    .createHash('sha256')
    .update(body.replace(/\r\n/g, '\n').trim(), 'utf8')
    .digest('hex')
    .slice(0, 16);
}

/** Injected reads + canonical-body override for {@link checkBlockDrift}. */
export interface BlockDriftDeps {
  readonly readFileSync?: (p: string) => string;
  readonly existsSync?: (p: string) => boolean;
  /** Canonical body override (defaults to {@link loadCanonicalBlockBody}). */
  readonly canonicalBody?: string | null;
  /** Explicit `block.md` path forwarded to the default canonical loader. */
  readonly blockPath?: string;
}

/**
 * Diagnose on-ramp block drift for the project at `projectRoot`.
 *
 *   - canonical source unavailable  → `Skipped` (never a false drift)
 *   - `AGENTS.md` absent            → `Warning` ("not installed")
 *   - installed body == canonical   → `Pass`
 *   - installed body != canonical   → `Warning` (hash-diff finding)
 */
export function checkBlockDrift(projectRoot: string, deps: BlockDriftDeps = {}): CheckResult {
  const start = Date.now();
  const base = { category: 'agent' as const, name: BLOCK_DRIFT_CHECK_NAME };
  const readFileSync = deps.readFileSync ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const existsSync = deps.existsSync ?? fs.existsSync;

  const canonicalBody =
    deps.canonicalBody !== undefined
      ? deps.canonicalBody
      : loadCanonicalBlockBody({
          readFileSync,
          existsSync,
          ...(deps.blockPath ? { blockPath: deps.blockPath } : {}),
        });

  if (canonicalBody == null) {
    return {
      ...base,
      status: 'Skipped',
      reason: 'canonical binding/standard/block.md not found',
      message: 'On-ramp drift check skipped: canonical block source is unavailable.',
      durationMs: Date.now() - start,
    };
  }

  const agentsPath = toPosix(join(projectRoot, AGENTS_MD_FILENAME));
  if (!existsSync(agentsPath)) {
    return {
      ...base,
      status: 'Warning',
      message: `${AGENTS_MD_FILENAME} on-ramp block is not installed.`,
      fix: 'Run `exarchos onboard` to install the Exarchos on-ramp block.',
      durationMs: Date.now() - start,
    };
  }

  let installed: string;
  try {
    installed = readFileSync(agentsPath);
  } catch {
    return {
      ...base,
      status: 'Warning',
      message: `Could not read ${agentsPath} to check on-ramp block drift.`,
      fix: `Ensure ${AGENTS_MD_FILENAME} is readable, then re-run \`exarchos doctor\`.`,
      durationMs: Date.now() - start,
    };
  }

  const installedHash = bodyHash(stripBindingFences(installed));
  const canonicalHash = bodyHash(canonicalBody);
  if (installedHash === canonicalHash) {
    return {
      ...base,
      status: 'Pass',
      message: `${AGENTS_MD_FILENAME} on-ramp block matches the canonical binding block.`,
      durationMs: Date.now() - start,
    };
  }

  return {
    ...base,
    status: 'Warning',
    message:
      `${AGENTS_MD_FILENAME} on-ramp block drifted from the canonical binding block ` +
      `(installed ${installedHash} vs expected ${canonicalHash}).`,
    fix: 'Run `exarchos onboard` to re-write the on-ramp block from binding/standard/block.md.',
    durationMs: Date.now() - start,
  };
}
