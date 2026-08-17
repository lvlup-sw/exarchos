// ─── The skills renderer — published module path ────────────────────────────
//
// The renderer is a pipeline, and the modules under `build-skills/` are its
// stages: parse and render the call macros, substitute the runtime's tokens,
// apply the capability guards, validate that nothing unresolved survives, copy
// and re-render the linked references, and write the tree. `build-all` drives
// them; `main` is the command-line entry point.
//
// This file is the path every consumer and test already imports, so it stays
// the renderer's published identity.

// The shared vocabulary already lived in its own module and was re-exported
// from here; that arrangement is unchanged.
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

// ─── Self-invocation guard ──────────────────────────────────────────────────
//
// Only run `main()` when this file is EXECUTED directly; importing it from a
// test must not trigger a build. It lives here rather than beside `main`
// because `package.json` runs `node dist/install/build-skills.js` — this
// module is the one whose `import.meta.url` can ever equal `argv[1]`, so the
// guard is inert anywhere else and the build would silently do nothing.
//
// `pathToFileURL` is required for correctness on Windows: `file://${argv[1]}`
// yields `file://C:\repo\dist\build-skills.js`, which never equals the
// `file:///C:/repo/dist/build-skills.js` form of `import.meta.url` — so the
// guard silently failed and `npm run build:skills` was a no-op that still
// exited 0, leaving the rendered tree stale against its sources.
import { pathToFileURL } from 'node:url';
import { main as runMain } from './build-skills/main.js';

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runMain(process.argv.slice(2));
}
