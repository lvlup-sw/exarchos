#!/usr/bin/env bun
/**
 * Codegen for the embedded runtimes module (#1213, #1214).
 *
 * Reads `runtimes/*.yaml` at build time, validates every entry against
 * `RuntimeMapSchema`, and emits a typed TS module
 * `src/install/runtimes/embedded.ts` that exports a frozen `EMBEDDED_RUNTIMES`
 * array. The emitted module is the runtime-side source of truth used by
 * the install-skills bridge from inside the compiled binary, where the
 * `runtimes/` directory is not on disk (the YAML files are not part of
 * the bundled artifact graph).
 *
 * ── Why a codegen step instead of a `Bun.embeddedFiles`-style trick ─────
 * The runtime YAML directory must remain the SINGLE source of truth so
 * authors edit one file. Embedding YAML *strings* into the binary would
 * still require a parse + Zod validation at user-runtime — including
 * `js-yaml` and `zod` in the hot path of every `install-skills`
 * invocation. Codegen sidesteps both: validation runs at build time and
 * the emitted module is plain JSON-shaped TypeScript, deeply frozen.
 *
 * ── Determinism contract ──────────────────────────────────────────────
 * The emitted file MUST be a pure function of `runtimes/*.yaml` so
 * `runtimes:guard` (CI) can re-run codegen and `git diff --exit-code`
 * the result. We enforce determinism by:
 *
 *   1. Sorting runtimes in canonical order: `REQUIRED_RUNTIME_NAMES`
 *      first (in declaration order), then any extras alphabetically.
 *   2. Using `JSON.stringify(value, null, 2)` for the inlined object
 *      literal, which preserves insertion order of string keys per the
 *      ECMAScript spec — the same invariant that backs the skills:guard
 *      determinism contract.
 *
 * Implements: PR #1213 review-item #4 (CodeRabbit), #1109 §2 (MCP parity).
 */

import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAllRuntimes, REQUIRED_RUNTIME_NAMES } from '../src/install/runtimes/load.js';
import type { RuntimeMap } from '../src/install/runtimes/types.js';

/**
 * Sort the loaded runtimes deterministically. `REQUIRED_RUNTIME_NAMES`
 * provides the canonical ordering for the well-known runtimes; any
 * extras (loaded with a warning by `loadAllRuntimes`) trail in
 * alphabetical order so the codegen output is total-ordered without
 * ever depending on filesystem iteration order.
 */
export function sortRuntimes(runtimes: readonly RuntimeMap[]): RuntimeMap[] {
  const requiredOrder = new Map<string, number>();
  REQUIRED_RUNTIME_NAMES.forEach((name, idx) => requiredOrder.set(name, idx));

  const required: RuntimeMap[] = [];
  const extras: RuntimeMap[] = [];
  for (const rt of runtimes) {
    if (requiredOrder.has(rt.name)) {
      required.push(rt);
    } else {
      extras.push(rt);
    }
  }
  required.sort((a, b) => {
    const ai = requiredOrder.get(a.name) ?? 0;
    const bi = requiredOrder.get(b.name) ?? 0;
    return ai - bi;
  });
  extras.sort((a, b) => a.name.localeCompare(b.name));
  return [...required, ...extras];
}

/**
 * Render the emitted `embedded.ts` source as a single string. Pulled
 * out so the unit test can compare two invocations for byte-for-byte
 * determinism without touching disk.
 */
export function renderEmbeddedRuntimesModule(runtimes: readonly RuntimeMap[]): string {
  const sorted = sortRuntimes(runtimes);
  const inlined = JSON.stringify(sorted, null, 2);

  return `// GENERATED FILE — DO NOT EDIT. Regenerate via \`npm run codegen:runtimes\`.
// Source: runtimes/*.yaml (validated against RuntimeMapSchema).
// Drift is enforced by \`npm run runtimes:guard\` (CI).
import type { RuntimeMap } from './types.js';

const RAW_RUNTIMES = ${inlined} as const;

/**
 * Deep-freeze a runtime map and any nested objects so the consumer
 * cannot mutate the embedded copy. \`Object.freeze\` is shallow, but the
 * shape is JSON-flat (objects + arrays + primitives), so a recursive
 * walk is sufficient.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

/**
 * Frozen array of validated \`RuntimeMap\` entries embedded into the
 * compiled binary. The bridge in
 * \`src/lifecycle/install-skills-bridge.js\`
 * prefers this array over reading \`runtimes/*.yaml\` from disk so
 * \`install-skills\` works inside the single-file binary, where the
 * YAML directory does not ship.
 *
 * Sorted by canonical \`REQUIRED_RUNTIME_NAMES\` order, then any extras
 * alphabetically — see \`scripts/codegen-runtimes.ts\` for the contract.
 */
export const EMBEDDED_RUNTIMES: readonly RuntimeMap[] = Object.freeze(
  RAW_RUNTIMES.map((r) => deepFreeze(r as unknown as RuntimeMap)),
) as readonly RuntimeMap[];

/**
 * Convenience lookup for a single embedded runtime by name. Returns
 * \`undefined\` when no embedded runtime matches — callers decide
 * whether to throw or fall back. Mirrors the \`findRuntime()\` helper
 * in \`src/install/install-skills.ts\` so call-site behavior is identical
 * regardless of whether the runtimes came from FS or the embedded
 * module.
 */
export function getEmbeddedRuntime(name: string): RuntimeMap | undefined {
  return EMBEDDED_RUNTIMES.find((r) => r.name === name);
}
`;
}

/**
 * Resolve the repo root from this file's location. The codegen script
 * lives at `scripts/codegen-runtimes.ts`, so the repo root is one
 * directory above. We use `import.meta.url` rather than `process.cwd()`
 * so the script is robust against being invoked from a sibling
 * directory.
 */
function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..');
}

/**
 * Load every runtime YAML in `runtimesDir`, render the embedded module,
 * and write it to `outFile`. Exported so tests can drive the same code
 * path against a temp directory.
 */
export function generateEmbeddedRuntimesModule(opts: {
  runtimesDir: string;
  outFile: string;
}): void {
  const runtimes = loadAllRuntimes(opts.runtimesDir);
  const source = renderEmbeddedRuntimesModule(runtimes);
  writeFileSync(opts.outFile, source, 'utf8');
}

// Self-invocation guard: only run the side-effecting codegen when this
// file is the entry point. Importing it from a test must NOT regenerate
// `src/install/runtimes/embedded.ts` against the real repo.
if (import.meta.main) {
  const root = repoRoot();
  generateEmbeddedRuntimesModule({
    runtimesDir: resolve(root, 'runtimes'),
    outFile: resolve(root, 'src/install/runtimes/embedded.ts'),
  });
  console.log(`Wrote src/install/runtimes/embedded.ts`);
}
