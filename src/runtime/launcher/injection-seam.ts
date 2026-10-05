/**
 * The seam that injects an ephemeral orientation payload at spawn. The payload goes on the env of the
 * spawned process, or on the native flag or env channel of the harness. It never goes into a repo file.
 *
 * The launcher does not own the prompt-precedence rules of the model, so it cannot force orientation to
 * lose to a user instruction. It tags the payload as non-authoritative, with a type and env keys that are
 * distinct from the `directive` channel. Tests assert the tag and the placement, not the precedence.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AsyncSpawnRequest } from '../../utils/process.js';
import type {
  EnvInjectionCandidate,
  FlagInjectionCandidate,
  InjectionCandidate,
} from './harness-registry.js';

/**
 * Injection channel discriminant. Authority is a property of the channel, and this seam does not enforce
 * it. `orientation` is non-authoritative context that the launcher injects. `directive` is the
 * authoritative channel, which the launcher does not emit.
 */
export type InjectionChannel = 'orientation' | 'directive';

/**
 * An ephemeral orientation payload, non-authoritative by construction. The type fixes
 * `channel: 'orientation'` and `authoritative: false`, so the tag cannot collapse into
 * {@link DirectivePayload}. `content` is opaque here.
 */
export interface OrientationPayload {
  readonly channel: 'orientation';
  readonly authoritative: false;
  readonly content: string;
}

/**
 * The authoritative directive channel, which the launcher does not emit. The type proves that the
 * orientation channel is distinct, and it names the channel of {@link DIRECTIVE_ENV_KEY}, which the
 * injector never writes.
 */
export interface DirectivePayload {
  readonly channel: 'directive';
  readonly authoritative: true;
  readonly content: string;
}

/** Either injection channel's payload — discriminated by `channel`. */
export type InjectionPayload = OrientationPayload | DirectivePayload;

/** Env var for the orientation content, distinct from {@link DIRECTIVE_ENV_KEY}. */
export const ORIENTATION_ENV_KEY = 'EXARCHOS_ORIENTATION' as const;

/**
 * Env var for the authority marker of the orientation payload. A well-behaved consumer reads
 * {@link NON_AUTHORITATIVE} here and puts each user instruction before the orientation.
 */
export const ORIENTATION_AUTHORITY_ENV_KEY = 'EXARCHOS_ORIENTATION_AUTHORITY' as const;

/**
 * Env var of the authoritative directive channel, distinct from the two orientation keys.
 * {@link injectOrientation} never writes it, so orientation cannot pose as a directive.
 */
export const DIRECTIVE_ENV_KEY = 'EXARCHOS_DIRECTIVE' as const;

/** The placed authority marker value for a non-authoritative orientation payload. */
export const NON_AUTHORITATIVE = 'non-authoritative' as const;

/** Builds a non-authoritative orientation payload from opaque content. The tag is fixed by construction. */
export function orientationPayload(content: string): OrientationPayload {
  return { channel: 'orientation', authoritative: false, content };
}

/** `true` iff the orientation channel discriminant is still `'orientation'`. */
type AssertOrientationChannel = OrientationPayload['channel'] extends 'orientation' ? true : never;

/** `true` iff orientation is still typed non-authoritative (`authoritative: false`). */
type AssertOrientationNonAuthoritative =
  OrientationPayload['authoritative'] extends false ? true : never;

/**
 * `true` iff the orientation discriminant does not extend the directive discriminant. If orientation gets
 * `channel: 'directive'`, this becomes `never`.
 */
type AssertChannelsDistinct =
  OrientationPayload['channel'] extends DirectivePayload['channel'] ? never : true;

/**
 * The three tag invariants, proven at compile time. Each alias is `true` when its tag holds and `never`
 * otherwise, so a collapsed tag fails `tsc --noEmit`. They live in this source file because
 * `tsconfig.json` excludes `*.test.ts`. The export keeps them live, and the test checks it at runtime.
 */
export const ORIENTATION_TAG_INVARIANTS: readonly [
  AssertOrientationChannel,
  AssertOrientationNonAuthoritative,
  AssertChannelsDistinct,
] = [true, true, true];

/**
 * Injects an orientation payload into the `env` of a spawn request. This function touches no filesystem.
 *
 * It returns a new request whose `env` also holds the content ({@link ORIENTATION_ENV_KEY}) and the
 * non-authoritative marker ({@link ORIENTATION_AUTHORITY_ENV_KEY}). It never mutates the base request and
 * never writes {@link DIRECTIVE_ENV_KEY}. With no payload, it returns the same base request, so the launch
 * adds no env key.
 */
export function injectOrientation(
  base: AsyncSpawnRequest,
  payload: OrientationPayload | undefined,
): AsyncSpawnRequest {
  if (payload === undefined) return base;
  return {
    ...base,
    env: {
      ...base.env,
      [ORIENTATION_ENV_KEY]: payload.content,
      [ORIENTATION_AUTHORITY_ENV_KEY]: NON_AUTHORITATIVE,
    },
  };
}

/**
 * The native orientation channel that the spawn-time probe `resolveInjectionChannel` selected: a `flag` or
 * `env` candidate that the live CLI supports, or `none`. It carries the candidate, so the applier uses the
 * exact flag or env var of the registry. The applier branches on this `kind` and never on a harness name,
 * so the single-abstraction guard passes.
 */
export type ResolvedInjectionChannel =
  | { readonly kind: 'flag'; readonly candidate: FlagInjectionCandidate }
  | { readonly kind: 'env'; readonly candidate: EnvInjectionCandidate }
  | { readonly kind: 'none'; readonly reason: string };

/**
 * A short, log/preview-safe label for a resolved channel — `flag:<flag>`,
 * `env:<var>`, or `none`. Used by the lifecycle result and the `--dry-run`
 * preview so the resolved channel is observable without leaking payload content.
 */
export function describeChannel(channel: ResolvedInjectionChannel): string {
  switch (channel.kind) {
    case 'flag':
      return `flag:${channel.candidate.flag}`;
    case 'env':
      return `env:${channel.candidate.envVar}`;
    case 'none':
      return 'none';
  }
}

/**
 * Filesystem seams for the native-channel applier. The `file` flag form (Claude Code
 * `--append-system-prompt-file`) and the `dir` env form (Copilot `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`) write
 * the payload to an ephemeral temp path. With these seams, a test can drive that path and force a failure.
 */
export interface ChannelApplyDeps {
  /** Writes the orientation content to an ephemeral temp file and returns its path. Throws on failure. */
  readonly writeTempFile?: (content: string) => string;
  /** Writes the orientation content to an ephemeral temp dir as a synthetic `AGENTS.md`, and returns the dir. Throws on failure. */
  readonly writeTempDir?: (content: string) => string;
  /** Invoked with the ephemeral file/dir path once created, so the caller can schedule its removal. */
  readonly onTempPathCreated?: (path: string) => void;
}

/** Conservative headroom under typical ARG_MAX/env-size ceilings for inline injection. */
const MAX_INLINE_ORIENTATION_BYTES = 32 * 1024;

/** Throws when `content` is too large to place inline on argv or env. The caller then launches with no orientation. */
function assertInlineSize(content: string): void {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_INLINE_ORIENTATION_BYTES) {
    throw new Error(
      `orientation content too large (${bytes} bytes) for inline flag/env injection`,
    );
  }
}

/**
 * Default `file`-form writer: an ephemeral temp file that holds the orientation. `onCreated` runs right
 * after `mkdtempSync` and before the write, which can fail. Thus the caller can remove the dir even when
 * the write throws.
 */
function defaultWriteTempFile(content: string, onCreated?: (path: string) => void): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'exarchos-orient-'));
  onCreated?.(dir);
  const file = path.join(dir, 'orientation.md');
  writeFileSync(file, content, 'utf8');
  return file;
}

/**
 * Default `dir`-form writer: an ephemeral temp dir that holds a synthetic `AGENTS.md`. `onCreated` runs
 * before the write, for the same reason as in {@link defaultWriteTempFile}.
 */
function defaultWriteTempDir(content: string, onCreated?: (path: string) => void): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'exarchos-orient-dir-'));
  onCreated?.(dir);
  writeFileSync(path.join(dir, 'AGENTS.md'), content, 'utf8');
  return dir;
}

/**
 * Applies a resolved native orientation channel to a placed spawn descriptor. It returns a new request,
 * never mutates the base, and never writes {@link DIRECTIVE_ENV_KEY}.
 *
 * For a `flag` or `env` channel, the payload goes on the native channel of the harness and also on the
 * tagged {@link ORIENTATION_ENV_KEY} layer through {@link injectOrientation}. A `none` channel returns the
 * base unchanged, and the launch runs with no orientation. A temp-file error or an oversized inline payload
 * throws. The caller then launches with no orientation and records a degradation.
 */
export function applyOrientationChannel(
  base: AsyncSpawnRequest,
  channel: ResolvedInjectionChannel,
  content: string,
  deps: ChannelApplyDeps = {},
): AsyncSpawnRequest {
  switch (channel.kind) {
    case 'flag':
      return applyFlagChannel(
        injectOrientation(base, orientationPayload(content)),
        channel.candidate,
        content,
        deps,
      );
    case 'env':
      return applyEnvChannel(
        injectOrientation(base, orientationPayload(content)),
        channel.candidate,
        content,
        deps,
      );
    case 'none':
      return base;
  }
}

/** Append the resolved flag + its payload-derived value to the spawn args. */
function applyFlagChannel(
  base: AsyncSpawnRequest,
  candidate: FlagInjectionCandidate,
  content: string,
  deps: ChannelApplyDeps,
): AsyncSpawnRequest {
  const value = flagValue(candidate, content, deps);
  return { ...base, args: [...base.args, candidate.flag, value] };
}

/**
 * Derives the flag argument from the payload by the `valueForm` of the candidate. A caller-supplied
 * `writeTempFile` reports its path after it returns. The default writer reports its temp dir before the
 * write, through `onCreated`.
 */
function flagValue(
  candidate: FlagInjectionCandidate,
  content: string,
  deps: ChannelApplyDeps,
): string {
  switch (candidate.valueForm) {
    case 'string':
      assertInlineSize(content);
      return content;
    case 'assignment':
      assertInlineSize(content);
      return `${candidate.assignmentKey}=${content}`;
    case 'file': {
      if (deps.writeTempFile) {
        const filePath = deps.writeTempFile(content);
        deps.onTempPathCreated?.(filePath);
        return filePath;
      }
      return defaultWriteTempFile(content, deps.onTempPathCreated);
    }
  }
}

/**
 * Places the payload-derived value of the resolved env channel on the spawn env. For `config-json`, the
 * harness parses the var as its own config JSON, so raw prose is invalid there. The payload then goes into
 * a temp instruction file, and the var holds `{"instructions": [<path>]}`. For `dir`, the var holds a temp
 * dir with a synthetic `AGENTS.md`.
 */
function applyEnvChannel(
  base: AsyncSpawnRequest,
  candidate: EnvInjectionCandidate,
  content: string,
  deps: ChannelApplyDeps,
): AsyncSpawnRequest {
  if (candidate.payload === 'config-json') {
    let filePath: string;
    if (deps.writeTempFile) {
      filePath = deps.writeTempFile(content);
      deps.onTempPathCreated?.(filePath);
    } else {
      filePath = defaultWriteTempFile(content, deps.onTempPathCreated);
    }
    const configJson = JSON.stringify({ instructions: [filePath] });
    return { ...base, env: { ...base.env, [candidate.envVar]: configJson } };
  }
  if (deps.writeTempDir) {
    const dirPath = deps.writeTempDir(content);
    deps.onTempPathCreated?.(dirPath);
    return { ...base, env: { ...base.env, [candidate.envVar]: dirPath } };
  }
  const dirPath = defaultWriteTempDir(content, deps.onTempPathCreated);
  return { ...base, env: { ...base.env, [candidate.envVar]: dirPath } };
}

/** Repo-relative location of the runtime-neutral orientation block (one content source). */
const STANDARD_BLOCK_REL = path.join('binding', 'standard', 'block.md');

/**
 * Loads the runtime-neutral orientation payload from `binding/standard/block.md`, the one content source.
 * From each search root it checks at most eight directories upward and returns the first hit. It never
 * throws. On a miss it returns `undefined`, and the caller launches with no orientation.
 */
export function loadStandardBlockContent(searchRoots?: readonly string[]): string | undefined {
  for (const root of searchRoots ?? defaultBlockSearchRoots()) {
    let dir = root;
    for (let depth = 0; depth < 8; depth++) {
      try {
        return readFileSync(path.join(dir, STANDARD_BLOCK_REL), 'utf8');
      } catch {
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

/**
 * Search roots for {@link loadStandardBlockContent}: the module dir, then `process.cwd()`. When
 * `import.meta.url` does not resolve, as in some bundles, only `process.cwd()` remains.
 */
function defaultBlockSearchRoots(): string[] {
  const roots: string[] = [];
  try {
    roots.push(path.dirname(fileURLToPath(import.meta.url)));
  } catch {
  }
  roots.push(process.cwd());
  return roots;
}

/**
 * Previews a channel with no probe: the first (most-preferred) declared candidate, labelled like
 * {@link describeChannel}. `--dry-run` uses it because it must not spawn a help probe. The live spawn path
 * resolves the channel with the real probe.
 */
export function previewInjectionChannel(candidates: readonly InjectionCandidate[]): string {
  const primary = candidates[0];
  if (primary === undefined) return 'none';
  switch (primary.kind) {
    case 'flag':
      return `flag:${primary.flag}`;
    case 'env':
      return `env:${primary.envVar}`;
    case 'none':
      return 'none';
  }
}
