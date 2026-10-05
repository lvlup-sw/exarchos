/**
 * The published module path of the skills renderer. Consumers and tests import the renderer from here.
 *
 * The modules under `build-skills/` are the stages of the renderer pipeline: call macros, token
 * substitution, capability guards, placeholder checks, reference copies, and the tree write.
 * `build-all` drives the stages, and `main` is the command-line entry point.
 *
 * `main()` runs only when Node runs this file directly, so an import from a test starts no build.
 * The guard is in this file because `package.json` runs `dist/install/build-skills.js`. It compares
 * `import.meta.url` with `pathToFileURL(argv[1])`, because a raw `file://` string of a Windows path
 * never matches.
 */

export {
  PLACEHOLDER_REGEX,
  CALL_MACRO_REGEX,
  REQUIRES_OPEN_REGEX,
  PREFIX_TOKENS,
  ORCHESTRATION_TOKENS,
  classifySkill,
  type SkillClass,
  type SkillModel,
} from './skill-vocabulary.js';

export {
  parseCallMacro,
  validateCallMacro,
  renderCallMacros,
  setRegistryLookup,
  clearRegistryLookup,
  type CallMacroAst,
  type RegistryAction,
  type RegistryLookup,
} from './build-skills/call-macro.js';
export { render, parseTokenArgs, type RenderContext } from './build-skills/render.js';
export { applyRequiresGuards, elideClaudeOnlyCodeBlocks } from './build-skills/requires-guards.js';
export { assertProceduralSkill } from './build-skills/procedural.js';
export { STANDARD_TREE_NAME } from './build-skills/standard-runtime.js';
export { validateChainTargets, assertNoUnresolvedPlaceholders } from './build-skills/placeholders.js';
export { copyReferences } from './build-skills/references-copy.js';
export { buildAllSkills, type BuildReport } from './build-skills/build-all.js';
export { assertRuntimeTokenCoverage } from './build-skills/token-coverage.js';
export { main } from './build-skills/main.js';
export type { MainDeps } from './cli-helpers.js';

import { pathToFileURL } from 'node:url';
import { main as runMain } from './build-skills/main.js';

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runMain(process.argv.slice(2));
}
