/**
 * Writes a starter `.exarchos.yml` at the repo root from the current detection results.
 * It never overwrites an existing file, and it writes nothing when no field resolves.
 * The hooks in {@link SeedOptions} replace the real file system and resolver in tests.
 */

import { existsSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

import {
  resolveVerificationRuntime,
  type ResolvedVerificationRuntime,
} from '../../config/test-runtime-resolver.js';

const CONFIG_FILENAME = '.exarchos.yml';

const HEADER = `# .exarchos.yml — Exarchos project configuration.
#
# This file declares the commands Exarchos uses for gates and worktree setup —
# test, typecheck, install, plus the verification-ladder commands mutation and
# lint (each seeded only when detection resolved one). Auto-seeded from detection
# at workflow init time. Edit freely; subsequent inits will not overwrite it.
#
# Set any field to override detection. Unset fields fall back to detection.
# Docs: https://github.com/lvlup-sw/exarchos/issues/1199
`;

/**
 * Commented-out onboarding block for architectural invariants.
 * It documents the opt-in and changes no behavior, because no catalog loads until the operator uncomments it.
 * The block must not mention `devCatalog`, even as a comment. That key is deprecated, and `doctor` flags it in an active config.
 * Registration in `catalogs:` is the only opt-in that onboarding teaches.
 */
const INVARIANTS_STANZA = `
# Architectural invariants (opt-in). Authoring guide:
# docs/guides/authoring-invariants.md. After uncommenting, validate with
# \`exarchos doctor\` (invariants-catalog check) and inspect the resolved
# catalog with the \`invariants_effective\` view.
# invariants:
#   # Register catalog files to load (paths relative to this file). A catalog
#   # surfaces at /ideate and the check_invariant_conformance gate ONLY when it
#   # is registered here. \`tier: dev\` marks a maintainer-authored catalog;
#   # \`tier: user\` (the default) marks a consumer one. User ids must NOT reuse
#   # the reserved INV-* / SDLC-* prefixes.
#   catalogs:
#     - { path: .exarchos/invariants.md, tier: user }
`;

export interface SeedResult {
  /** True when the function wrote a new file. */
  wrote: boolean;
  /** Path of the target file. */
  path: string;
  /** Why the function wrote the file or did not write it. */
  reason: 'created' | 'already-exists' | 'unresolved-no-fields';
}

export interface SeedOptions {
  /** Inject for tests. Defaults to fs.existsSync. */
  exists?: (p: string) => boolean;
  /** Inject for tests. Defaults to fs.writeFileSync. */
  write?: (p: string, contents: string) => void;
  /** Inject for tests. Defaults to the real widened verification resolver. */
  resolve?: (repoRoot: string) => ResolvedVerificationRuntime;
}

/**
 * Seeds `.exarchos.yml` from `resolveVerificationRuntime`, which resolves `test`, `typecheck`, `install`, `mutation`, and `lint`.
 * The no-op check includes `mutation` and `lint`, because they can resolve when the other three do not.
 * The YAML holds only the resolved commands, in that order, as top-level keys that override detection.
 * It never writes a `verification:` policy block, because that block freezes the current builtin policy into consumer config.
 */
export function seedExarchosConfig(
  repoRoot: string,
  options?: SeedOptions,
): SeedResult {
  const target = path.join(repoRoot, CONFIG_FILENAME);
  const exists = options?.exists ?? existsSync;
  const write = options?.write ?? ((p, contents) => writeFileSync(p, contents, 'utf8'));
  const resolve = options?.resolve ?? ((root: string) => resolveVerificationRuntime(root));

  if (exists(target)) {
    return { wrote: false, path: target, reason: 'already-exists' };
  }

  const result = resolve(repoRoot);

  if (
    result.source === 'unresolved' &&
    result.test === null &&
    result.typecheck === null &&
    result.install === null &&
    result.mutation === null &&
    result.lint === null
  ) {
    return { wrote: false, path: target, reason: 'unresolved-no-fields' };
  }

  const body: Record<string, string> = {};
  if (result.test !== null) body.test = result.test;
  if (result.typecheck !== null) body.typecheck = result.typecheck;
  if (result.install !== null) body.install = result.install;
  if (result.mutation !== null) body.mutation = result.mutation;
  if (result.lint !== null) body.lint = result.lint;

  const yamlBody = stringifyYaml(body);
  const contents = HEADER + yamlBody + INVARIANTS_STANZA;

  write(target, contents);

  return { wrote: true, path: target, reason: 'created' };
}
