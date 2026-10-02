#!/usr/bin/env bun
/**
 * Codegen for the embedded runtimes module. It reads `content/harness/runtimes/*.yaml` at build
 * time, validates each entry against `RuntimeMapSchema`, and writes
 * `src/install/runtimes/embedded.ts`, which exports a frozen `EMBEDDED_RUNTIMES` array. The
 * install-skills bridge in the compiled binary reads that module, because the YAML files are not
 * in the bundled artifact graph.
 *
 * The YAML directory stays the one source of truth. Validation runs at build time, so the binary
 * does not parse or validate YAML at user runtime. The output must be a pure function of the YAML,
 * so that `runtimes:guard` can re-run codegen and diff the result. So the runtimes sort in a
 * canonical order, and `JSON.stringify(value, null, 2)` keeps the key order.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAllRuntimes, REQUIRED_RUNTIME_NAMES } from '../../src/install/runtimes/load.js';
import type { RuntimeMap } from '../../src/install/runtimes/types.js';

/**
 * Sorts the loaded runtimes deterministically. The `REQUIRED_RUNTIME_NAMES` order comes first.
 * Extras, which `loadAllRuntimes` loads with a warning, follow in alphabetical order. So the output
 * never depends on the filesystem iteration order.
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
// Source: content/harness/runtimes/*.yaml (validated against RuntimeMapSchema).
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
 * prefers this array over reading \`content/harness/runtimes/*.yaml\` from disk so
 * \`install-skills\` works inside the single-file binary, where the
 * YAML directory does not ship.
 *
 * Sorted by canonical \`REQUIRED_RUNTIME_NAMES\` order, then any extras
 * alphabetically — see \`tools/release/codegen-runtimes.ts\` for the contract.
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
 * Resolves the repo root from `import.meta.url`, two directories above this file, and not from
 * `process.cwd()`. So the script works from any working directory.
 */
function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..');
}

/**
 * Loads every runtime YAML in `runtimesDir`, renders the embedded module, and writes it to
 * `outFile`. Tests drive the same code path against a temp directory. A file that already holds
 * the rendered text stays as it is. Each build runs this against the tracked copy, and a rewrite
 * exposes a truncated file to a concurrent reader. The module runs it on the real repo only when
 * this file is the entry point, so a test import does not regenerate `src/install/runtimes/embedded.ts`.
 */
export function generateEmbeddedRuntimesModule(opts: {
  runtimesDir: string;
  outFile: string;
}): void {
  const runtimes = loadAllRuntimes(opts.runtimesDir);
  const source = renderEmbeddedRuntimesModule(runtimes);
  if (existsSync(opts.outFile) && readFileSync(opts.outFile, 'utf8') === source) return;
  writeFileSync(opts.outFile, source, 'utf8');
}

if (import.meta.main) {
  const root = repoRoot();
  generateEmbeddedRuntimesModule({
    runtimesDir: resolve(root, 'content/harness/runtimes'),
    outFile: resolve(root, 'src/install/runtimes/embedded.ts'),
  });
  console.log(`Wrote src/install/runtimes/embedded.ts`);
}
