/**
 * invariants-catalog — do the configured invariant catalogs parse and merge
 * cleanly? (#1479)
 *
 * Resolves the effective catalog via `probes.invariants.resolve()`, which folds
 * every DR-9 degradation into a `warnings` list: malformed/missing user catalog
 * files and reserved-namespace ids (`INV-*` / `SDLC-*`) in a user catalog, plus
 * any typed `.exarchos.yml` deprecation. Any warning yields a doctor Warning
 * that names the offending catalog/id; a clean resolution of a registered
 * catalog Passes; when NO catalog is registered at all it Skips.
 *
 * The Skip signal is `configured`, NOT an entry count: the resolver projects to
 * a representative phase only to surface warnings, so a phase-filtered count
 * would misreport a configured-but-non-matching catalog as "nothing to
 * validate" (#1482 review).
 *
 * DR-31 / T-43: `configured` asks *"is a catalog REGISTERED?"*, never *"is the
 * `devCatalog` boolean enabled?"* — so the Skip reason below names registration
 * as the remedy. The boolean it used to name no longer exists as a mechanism.
 */

import type { CheckFn } from './__shared__/make-stub-probes.js';

export const invariantsCatalog: CheckFn = async (probes, signal) => {
  const start = Date.now();
  const base = { category: 'invariants' as const, name: 'invariants-catalog' };

  const { configured, warnings } = await probes.invariants.resolve(signal);

  if (warnings.length > 0) {
    const first = warnings[0]!;
    const more = warnings.length > 1 ? ` (+${warnings.length - 1} more)` : '';
    return {
      ...base,
      status: 'Warning',
      message: `Invariant catalog resolution surfaced ${warnings.length} warning(s): ${first}${more}`,
      fix:
        'Fix the offending user catalog: repair its YAML, point ' +
        'invariants.catalogs at the correct path, or rename any entry that ' +
        'reuses the reserved INV-* / SDLC-* id namespace. If the warning names ' +
        'a deprecated key, apply the replacement registration it prints. ' +
        'Inspect the resolved catalog with `exarchos view invariants_effective`.',
      durationMs: Date.now() - start,
    };
  }

  if (!configured) {
    return {
      ...base,
      status: 'Skipped',
      message: 'No invariant catalog to validate (none registered in .exarchos.yml)',
      reason:
        'No invariant catalog to validate: `invariants.catalogs` registers ' +
        'nothing. Register a catalog in .exarchos.yml to validate one, e.g. ' +
        '`invariants: { catalogs: [{ path: .exarchos/invariants.md, tier: dev }] }`.',
      durationMs: Date.now() - start,
    };
  }

  return {
    ...base,
    status: 'Pass',
    message: 'Configured invariant catalog(s) resolved cleanly, no warnings',
    durationMs: Date.now() - start,
  };
};
