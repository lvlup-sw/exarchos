// ─── `exarchos version --check-plugin-root <path>` subcommand ─────────────
//
// Standalone diagnostic / CI utility that calls the shared
// {@link checkPluginRootCompatibility} library against a given plugin
// root and exits with a canonical code:
//
//   exit 0 — binary satisfies plugin.compat.minBinaryVersion, OR plugin
//            has no compat metadata / no plugin.json (non-fatal advisory
//            printed to stderr).
//   exit 1 — declared minBinaryVersion is newer than the running binary
//            (drift — CI should fail).
//
// Human-readable output:
//   - compatible case: single stdout line confirming the match.
//   - incompatible case: stderr message naming both versions.
//   - advisory case: stderr warning explaining why the check was skipped.
//
// The binary version is sourced from `SERVER_VERSION` in `src/index.ts`
// by default, but tests (and callers that already know the version) may
// pass `binaryVersion` explicitly to avoid pulling the full index graph
// on CLI cold-start. The production CLI wire-up in `adapters/cli.ts`
// passes a literal string so this subcommand stays cheap to dispatch.

import { checkPluginRootCompatibility } from '../lib/plugin-compat.js';

// ─── Options ────────────────────────────────────────────────────────────────

export interface VersionCheckOptions {
  /** Absolute path to the plugin root (directory containing .claude-plugin/plugin.json). */
  readonly pluginRoot: string;
  /** Running binary's semver. Typically SERVER_VERSION from src/index.ts. */
  readonly binaryVersion: string;
}

// ─── Handler ────────────────────────────────────────────────────────────────

/**
 * Entry point for `exarchos version --check-plugin-root <path>`.
 *
 * Returns the exit code rather than calling `process.exit()` directly so
 * that tests can assert the code without terminating the vitest worker.
 * The production wire-up in `adapters/cli.ts` assigns the return value to
 * `process.exitCode`.
 *
 * Output convention mirrors the rest of the adapter:
 *   - compatible → stdout (caller treats exit 0 as "ok").
 *   - warnings / drift → stderr (caller sees the message even when
 *     redirecting stdout to a file in a CI pipeline).
 */
export async function handleVersionCheck(
  opts: VersionCheckOptions,
): Promise<number> {
  const result = checkPluginRootCompatibility(opts.pluginRoot, opts.binaryVersion);

  // Advisory case — plugin.json missing, malformed, or lacks compat metadata.
  // Not an error, but surface to stderr so CI logs show the reason the
  // check was a no-op.
  if (result.minRequired === null) {
    process.stderr.write(`exarchos version: ${result.message}\n`);
    return 0;
  }

  if (!result.compatible) {
    // Drift — CI should fail. stderr carries the structured message so
    // log scrapers can key on the literal "minBinaryVersion" token.
    process.stderr.write(`exarchos version: ${result.message}\n`);
    return 1;
  }

  // Compatible — single stdout line confirming the match.
  process.stdout.write(`${result.message}\n`);
  return 0;
}
