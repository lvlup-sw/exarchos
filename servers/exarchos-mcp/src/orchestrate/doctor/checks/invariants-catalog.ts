/**
 * invariants-catalog — do the configured invariant catalogs parse and merge
 * cleanly? (#1479)
 *
 * Resolves the effective catalog via `probes.invariants.resolve()`, which folds
 * every DR-9 degradation into a `warnings` list: malformed/missing user catalog
 * files and reserved-namespace ids (`INV-*` / `SDLC-*`) in a user catalog. Any
 * warning yields a doctor Warning that names the offending catalog/id; a clean
 * resolution with entries Passes; an empty resolution with no warnings Skips
 * (dev catalog disabled and no user catalogs configured — nothing to validate).
 */

import type { CheckFn } from './__shared__/make-stub-probes.js';

export const invariantsCatalog: CheckFn = async (probes, signal) => {
  const start = Date.now();
  const base = { category: 'invariants' as const, name: 'invariants-catalog' };

  const { entryCount, warnings } = await probes.invariants.resolve(signal);

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
        'reuses the reserved INV-* / SDLC-* id namespace. Inspect the resolved ' +
        'catalog with `exarchos view invariants_effective`.',
      durationMs: Date.now() - start,
    };
  }

  if (entryCount === 0) {
    return {
      ...base,
      status: 'Skipped',
      message:
        'No invariant catalog to validate (dev catalog disabled, no user catalogs configured)',
      reason:
        'No invariant catalog to validate: invariants.devCatalog is disabled ' +
        'and invariants.catalogs is empty. Enable the dev catalog or add a ' +
        'user catalog in .exarchos.yml to validate one.',
      durationMs: Date.now() - start,
    };
  }

  return {
    ...base,
    status: 'Pass',
    message: `Invariant catalog resolved cleanly: ${entryCount} entr${entryCount === 1 ? 'y' : 'ies'}, no warnings`,
    durationMs: Date.now() - start,
  };
};
