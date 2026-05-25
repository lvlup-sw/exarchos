/**
 * seedExarchosConfig — T14 (#1199 Stage 2).
 *
 * Writes a starter `.exarchos.yml` at the repo root from current
 * detection results so users have a discoverable config to edit.
 *
 * Contract:
 *   - Idempotent: never overwrites an existing `.exarchos.yml`.
 *   - Empty-detection no-op: skips writing when nothing was detected
 *     (test/typecheck/install all null).
 *   - Pure-by-default with injected fs hooks for tests.
 */

import { existsSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

import {
  resolveTestRuntime,
  type ResolvedRuntime,
} from '../../config/test-runtime-resolver.js';

const CONFIG_FILENAME = '.exarchos.yml';

const HEADER = `# .exarchos.yml — Exarchos project configuration.
#
# This file declares the test/typecheck/install commands Exarchos should
# use for gates and worktree setup. Auto-seeded from detection at workflow
# init time. Edit freely; subsequent inits will not overwrite it.
#
# Set any field to override detection. Unset fields fall back to detection.
# Docs: https://github.com/lvlup-sw/exarchos/issues/1199
`;

// Commented onboarding stanza for the architectural-invariants surface
// (#1479). Emitted as comments so seeding documents the opt-in WITHOUT
// changing behaviour: the dev catalog stays effectively disabled until the
// operator uncomments the block. Authoring guide:
// docs/guides/authoring-invariants.md; inspect the resolved catalog with
// `exarchos view invariants_effective`.
const INVARIANTS_STANZA = `
# Architectural invariants (opt-in). Authoring guide:
# docs/guides/authoring-invariants.md. After uncommenting, validate with
# \`exarchos doctor\` (invariants-catalog check) and inspect the resolved
# catalog with the \`invariants_effective\` view.
# invariants:
#   # Surface the built-in architectural-invariants dev catalog (INV-*) to
#   # /ideate and the check_invariant_conformance gate. Default: disabled.
#   devCatalog: disabled
#   # Layer your own catalog files on top of the built-ins (paths relative to
#   # this file). User ids must NOT reuse the reserved INV-* / SDLC-* prefixes.
#   catalogs:
#     - .exarchos/invariants.md
`;

export interface SeedResult {
  /** Did we write a new config file? */
  wrote: boolean;
  /** Path of the file we wrote (or considered). */
  path: string;
  /** Why we did or didn't write. */
  reason: 'created' | 'already-exists' | 'unresolved-no-fields';
}

export interface SeedOptions {
  /** Inject for tests. Defaults to fs.existsSync. */
  exists?: (p: string) => boolean;
  /** Inject for tests. Defaults to fs.writeFileSync. */
  write?: (p: string, contents: string) => void;
  /** Inject for tests. Defaults to the real resolver. */
  resolve?: (repoRoot: string) => ResolvedRuntime;
}

export function seedExarchosConfig(
  repoRoot: string,
  options?: SeedOptions,
): SeedResult {
  const target = path.join(repoRoot, CONFIG_FILENAME);
  const exists = options?.exists ?? existsSync;
  const write = options?.write ?? ((p, contents) => writeFileSync(p, contents, 'utf8'));
  const resolve = options?.resolve ?? ((root: string) => resolveTestRuntime(root));

  if (exists(target)) {
    return { wrote: false, path: target, reason: 'already-exists' };
  }

  const result = resolve(repoRoot);

  if (
    result.source === 'unresolved' &&
    result.test === null &&
    result.typecheck === null &&
    result.install === null
  ) {
    return { wrote: false, path: target, reason: 'unresolved-no-fields' };
  }

  // Build YAML body from non-null fields only — preserves ordering for
  // human readability (test, typecheck, install).
  const body: Record<string, string> = {};
  if (result.test !== null) body.test = result.test;
  if (result.typecheck !== null) body.typecheck = result.typecheck;
  if (result.install !== null) body.install = result.install;

  const yamlBody = stringifyYaml(body);
  const contents = HEADER + yamlBody + INVARIANTS_STANZA;

  write(target, contents);

  return { wrote: true, path: target, reason: 'created' };
}
