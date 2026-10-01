/**
 * Doctor check: the configured invariant catalogs parse and merge without warnings.
 * It reads `probes.invariants.resolve()`. Any warning gives a Warning result that names the first warning.
 * A registered catalog with no warnings gives Pass. When no catalog is registered, the check gives Skipped.
 *
 * The Skip signal is `configured`, which tells if a catalog is registered. It is not an entry count.
 * The resolver projects to one sample phase only to collect warnings.
 * A count for that phase can be zero for a registered catalog that matches no entry.
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
