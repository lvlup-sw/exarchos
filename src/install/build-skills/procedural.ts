import { classifySkill, ORCHESTRATION_TOKENS } from '../skill-vocabulary.js';

export function assertProceduralSkill(body: string, sourcePath: string): void {
  const model = classifySkill(body);

  if (model.orchestrationTokensUsed.size > 0) {
    const offenders = [...model.orchestrationTokensUsed].sort();
    throw new Error(
      `[build:skills] procedural skill ${sourcePath} references orchestration ` +
        `token(s) {{${offenders.join('}}, {{')}}}. Procedural skills collapse to a ` +
        `single canonical render and must not use orchestration tokens ` +
        `[${[...ORCHESTRATION_TOKENS].sort().join(', ')}]. Move this skill to the ` +
        `orchestration residual, or remove the token.`,
    );
  }

  if (model.hasCapabilityGuard) {
    throw new Error(
      `[build:skills] procedural skill ${sourcePath} contains a ` +
        `<!-- requires:* --> capability guard. Capability gating is an ` +
        `orchestration-only construct; procedural skills render once for all ` +
        `runtimes. Move this skill to the orchestration residual, or remove the guard.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Standard (single-render) variant for procedural skills (DR-1)
// ---------------------------------------------------------------------------

/**
 * Output subtree name for the single, runtime-neutral render of every
 * procedural skill. Procedural skills collapse to `skills/standard/<skill>/`
 * (DR-1) instead of forking per-runtime; only the 3 orchestration skills
 * (`delegate`, `refactor`, `ideate`) keep the
 * `skills/<runtime>/<skill>/` residual.
 */
