import { classifySkill, ORCHESTRATION_TOKENS } from '../skill-vocabulary.js';

/**
 * Throw when a procedural skill source uses an orchestration token or a `<!-- requires:* -->` guard.
 * A procedural skill has one render for all runtimes, so either construct loses its per-runtime output.
 * `buildAllSkills` calls this only for a source that `classifySkill` puts in the procedural class.
 */
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
