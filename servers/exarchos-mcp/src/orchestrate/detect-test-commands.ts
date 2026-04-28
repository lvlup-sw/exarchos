// ─── Polyglot Test Command Detection (Compatibility Shim) ───────────────────
//
// Compatibility shim over `resolveTestRuntime` (../config/test-runtime-resolver).
// The resolver is the new authoritative source for runtime detection. This
// module preserves the legacy `detectTestCommands` signature and return shape
// (`TestCommands`) so existing call sites in `cli-commands/gates.ts` and
// `orchestrate/pre-synthesis-check.ts` continue to behave identically.
//
// Behavior preservation notes:
//   * Override path returns `{ test: override, typecheck: null }` — matches
//     pre-shim behavior exactly (resolver's typecheck inference is dropped
//     here on purpose).
//   * Resolver `source: 'unresolved'` combined with a present `package.json`
//     falls back to the legacy hardcoded `npm run test:run` /
//     `npm run typecheck`. This preserves the pre-#1174 invariant that any
//     package.json yields npm commands. T17 (graceful-skip) reverses this
//     fallback by surfacing the unresolved signal to gate consumers.
// ────────────────────────────────────────────────────────────────────────────

import { existsSync } from 'node:fs';
import * as path from 'node:path';

import { resolveTestRuntime } from '../config/test-runtime-resolver.js';

export interface TestCommands {
  test: string | null;
  typecheck: string | null;
}

/** Allowlist pattern for test command overrides. Rejects shell metacharacters (;|&$`(){}!<>). */
const SAFE_COMMAND_PATTERN = /^[a-zA-Z0-9_\-\s:.=\/+,@"'\\]+$/;

export function detectTestCommands(repoRoot: string, override?: string): TestCommands {
  if (override) {
    // Preserve the legacy error message ("Invalid testCommand") rather than
    // the resolver's "Invalid test override" wording. Existing callers and
    // tests assert on this string.
    if (!SAFE_COMMAND_PATTERN.test(override)) {
      throw new Error(
        `Invalid testCommand: contains disallowed characters. Must match ${SAFE_COMMAND_PATTERN}`,
      );
    }
    return { test: override, typecheck: null };
  }

  const resolved = resolveTestRuntime(repoRoot);

  // SHIM-COMPAT: Pre-#1174 behavior returned npm commands for any package.json,
  // even without a `scripts.test:run` entry. Preserve that until T17 lands
  // graceful-skip and routes the unresolved signal to gate consumers.
  if (resolved.source === 'unresolved' && existsSync(path.join(repoRoot, 'package.json'))) {
    return { test: 'npm run test:run', typecheck: 'npm run typecheck' };
  }

  return { test: resolved.test, typecheck: resolved.typecheck };
}
