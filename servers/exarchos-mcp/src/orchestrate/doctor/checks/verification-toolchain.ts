/**
 * verification-toolchain — does the verification ladder's runtime resolve, and
 * where does each policy cell come from? (design §4.6)
 *
 * Today no doctor check reports whether the verification ladder's commands
 * resolve, so an unresolved toolchain degrades the gates (test-adequacy,
 * mutation, etc.) SILENTLY. This is the 13th check, closing that visibility gap.
 *
 * Status mapping over `probes.verificationToolchain.resolve()`:
 *   - Pass    — `test`, `typecheck`, AND `mutation` all resolve. `lint` is
 *               reported informationally in the message either way.
 *   - Warning — any of that triple is unresolved. `fix` names BOTH remedies:
 *               `exarchos doctor --fix` (seeds what detection found) AND
 *               declaring the field in `.exarchos.yml` / a `toolchains:` entry
 *               for what detection can't see.
 *   - Skipped — no toolchain detectable at all (empty/unmarked repo); `reason`
 *               names what detection looked for.
 *
 * The result ALWAYS carries `policyCells`: the six `(riskTier × boundaryTouching)`
 * verification-policy cells with their `builtin`/`config` provenance, and the
 * message summarizes that provenance. This is READ-ONLY visibility — the check
 * never writes or seeds anything; the fix path stays the reconciler's.
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

export const verificationToolchain: CheckFn = async (probes, signal) => {
  const start = Date.now();
  const base = { category: 'verification' as const, name: 'verification-toolchain' };

  const resolution = await probes.verificationToolchain.resolve(signal);
  const { detected, runtime } = resolution;
  // Copy the readonly probe cells into a fresh mutable array — `CheckResult`'s
  // schema-derived `policyCells` is mutable, and the provenance is carried by
  // value onto the result (read-only visibility, the check never mutates policy).
  const policyCells = resolution.policyCells.map((c) => ({
    riskTier: c.riskTier,
    boundaryTouching: c.boundaryTouching,
    source: c.source,
  }));
  const policyNote = policyProvenanceSummary(policyCells);

  // Skipped — nothing detectable at all (empty/unmarked repo). DIM-2: the
  // `reason` names what detection looked for so the skip is never silent.
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

  // The Pass triple: test + typecheck + mutation must all resolve. lint is
  // informational only (it never gates the status).
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
      // BOTH remedies, per the contract: the reconciler seeds what detection
      // already found, and declaring the field covers what detection can't see.
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
