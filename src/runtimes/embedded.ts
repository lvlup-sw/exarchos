/**
 * Embedded runtime-map loader.
 *
 * The compiled `exarchos` binary has no on-disk `runtimes/*.yaml` at user-
 * install time, so the disk-based `loadAllRuntimes()` (used by the renderer
 * during a repo-local build) cannot serve the `install-skills` subcommand.
 * This module exposes the validated runtime maps that were baked into the
 * binary at build time via `scripts/generate-runtimes.ts`.
 *
 * Embedding strategy: build-time codegen → `runtimes.generated.ts`. The
 * Bun-only `import yaml with { type: "text" }` attribute path was rejected
 * because Node (vitest + tsc) cannot resolve YAML imports
 * (ERR_UNKNOWN_FILE_EXTENSION); a generated `.ts` module is portable across
 * both runtimes. See `spike(#1201)` commit for the full rationale.
 *
 * Implements: DR-7 (install-skills CLI), task 1.3 of the v2.9.0 closeout
 * (#1201).
 */

import type { RuntimeMap } from './types.js';
import { EMBEDDED_RUNTIMES } from './runtimes.generated.js';

/**
 * Return the embedded runtime maps keyed by `name`. The result is a frozen
 * object owned by the generated module; callers must not mutate entries.
 */
export function loadEmbeddedRuntimes(): Readonly<Record<string, RuntimeMap>> {
  return EMBEDDED_RUNTIMES;
}
