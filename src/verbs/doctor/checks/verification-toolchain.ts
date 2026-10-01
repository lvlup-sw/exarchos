/**
 * Doctor check: the verification ladder resolves its commands, and each policy cell shows its source.
 * Without this check, an unresolved toolchain degrades the gates and gives no signal.
 *
 * Status over `probes.verificationToolchain.resolve()`:
 * - Pass: `test`, `typecheck`, and `mutation` all resolve. The message reports `lint`, but `lint` never sets the status.
 * - Warning: one or more of these three fields is unresolved. `fix` names two remedies.
 *   The first is `exarchos doctor --fix`. The second is a declaration in `.exarchos.yml` or a `toolchains:` entry.
 * - Skipped: detection finds no toolchain. `reason` names what detection looked for.
 *
 * Every result carries `policyCells`: the six verification-policy cells, each with its `builtin` or `config` source.
 * The check is read-only and writes nothing.
 */

import type { CheckFn } from './__shared__/make-stub-probes.js';

/** Format the `lint` cell for the informational message tail. */
function lintNote(lint: string | null): string {
  return lint !== null ? `lint resolves (\`${lint}\`)` : 'lint unresolved';
}

/** One-line provenance summary across the six policy cells. */
function policyProvenanceSummary(
  policyCells: ReadonlyArray<{ source: 'builtin' | 'config' }>,
): string {
  const builtin = policyCells.filter((c) => c.source === 'builtin').length;
  const config = policyCells.filter((c) => c.source === 'config').length;
  return `policy: ${builtin}/${policyCells.length} cells builtin, ${config}/${policyCells.length} config`;
}

/** The check. It copies the read-only probe cells into a new array, because the `policyCells` field of `CheckResult` is mutable. */
export const verificationToolchain: CheckFn = async (probes, signal) => {
  const start = Date.now();
  const base = { category: 'verification' as const, name: 'verification-toolchain' };

  const resolution = await probes.verificationToolchain.resolve(signal);
  const { detected, runtime } = resolution;
  const policyCells = resolution.policyCells.map((c) => ({
    riskTier: c.riskTier,
    boundaryTouching: c.boundaryTouching,
    source: c.source,
  }));
  const policyNote = policyProvenanceSummary(policyCells);

  if (!detected) {
    return {
      ...base,
      status: 'Skipped' as const,
      message: `No verification toolchain detected; ${policyNote}`,
      reason:
        'No project markers (package.json / a recognised toolchain) and no ' +
        'test/typecheck/mutation entries in .exarchos.yml were detected, so no ' +
        'verification runtime could be resolved. Add a project toolchain or ' +
        'declare commands in .exarchos.yml to enable the verification ladder.',
      durationMs: Date.now() - start,
      policyCells,
    };
  }

  const unresolved = (['test', 'typecheck', 'mutation'] as const).filter(
    (field) => runtime[field] === null,
  );

  if (unresolved.length > 0) {
    return {
      ...base,
      status: 'Warning' as const,
      message:
        `Verification toolchain incomplete: ${unresolved.join(', ')} unresolved ` +
        `(${lintNote(runtime.lint)}); ${policyNote}`,
      fix:
        'Run `exarchos doctor --fix` to seed the commands detection found, AND ' +
        `declare the unresolved field(s) (${unresolved.join(', ')}) explicitly ` +
        'in .exarchos.yml (e.g. `mutation: npx stryker run`) or via a ' +
        '`toolchains:` entry for toolchains detection cannot infer.',
      durationMs: Date.now() - start,
      policyCells,
    };
  }

  return {
    ...base,
    status: 'Pass' as const,
    message:
      `Verification toolchain resolves: test (\`${runtime.test}\`), ` +
      `typecheck (\`${runtime.typecheck}\`), mutation (\`${runtime.mutation}\`); ` +
      `${lintNote(runtime.lint)}; ${policyNote}`,
    durationMs: Date.now() - start,
    policyCells,
  };
};
