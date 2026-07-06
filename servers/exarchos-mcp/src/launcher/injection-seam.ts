// ─── Authority-bounded ephemeral orientation-injection seam (DR-7) ───────────
//
// At spawn, an ORIENTATION payload can be injected into the child's ENV channel
// (the `env: Record<string,string>` of the spawn descriptor) with **no repo-file
// mutation**. Orientation is transient — it lives only on the spawned process's
// environment, never on disk.
//
// ## Authority is MARKED, not ENFORCED
//
// The launcher does NOT own the model's prompt-precedence rules, so it cannot
// *force* orientation to lose to a user's own instructions. What it CAN do is:
//
//   1. **tag** the payload as `orientation` / non-authoritative — a DISTINCT
//      type and env channel from any authoritative `directive` channel, and
//   2. **place** it where a well-behaved consumer treats it as non-authoritative
//      (its own dedicated env keys, carrying an explicit `non-authoritative`
//      authority marker; never the directive key).
//
// A test therefore asserts the tag + placement, NOT runtime precedence over the
// model (which this seam cannot own — see `Injection_TaggedNonAuthoritative...`).
//
// ## Scope boundary
//
// Content/format of the orientation text is owned by #1485 — out of scope here.
// This module ships only the *seam*: the typed, tagged payload and the pure,
// file-free env placement. The lifecycle integrator (a sibling task) slots the
// seam output into the placed spawn descriptor; nothing here wires it live.
// ────────────────────────────────────────────────────────────────────────────

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AsyncSpawnRequest } from '../utils/process.js';
import type {
  EnvInjectionCandidate,
  FlagInjectionCandidate,
  InjectionCandidate,
} from './harness-registry.js';

/**
 * Injection channel discriminant. Authority is a *property of the channel*, not
 * something this seam enforces at runtime:
 *   - `orientation` → non-authoritative, ephemeral context the launcher injects.
 *   - `directive`   → authoritative instruction channel the launcher does NOT emit.
 */
export type InjectionChannel = 'orientation' | 'directive';

/**
 * An ephemeral orientation payload — NON-authoritative by construction. Both the
 * `channel: 'orientation'` discriminant and the literal `authoritative: false`
 * are baked into the type, so the tag cannot silently collapse into the
 * authoritative {@link DirectivePayload}. `content` is opaque here (format owned
 * by #1485).
 */
export interface OrientationPayload {
  readonly channel: 'orientation';
  readonly authoritative: false;
  readonly content: string;
}

/**
 * The DISTINCT authoritative directive channel — the type-level counterpart the
 * orientation tag must never collapse into. The launcher does NOT emit these;
 * the type exists so the orientation channel is *provably* distinct, and so the
 * injector's refusal to ever write {@link DIRECTIVE_ENV_KEY} is expressible.
 */
export interface DirectivePayload {
  readonly channel: 'directive';
  readonly authoritative: true;
  readonly content: string;
}

/** Either injection channel's payload — discriminated by `channel`. */
export type InjectionPayload = OrientationPayload | DirectivePayload;

/**
 * Env var the ephemeral orientation *content* rides on — orientation's own
 * dedicated channel, DISTINCT from {@link DIRECTIVE_ENV_KEY}.
 */
export const ORIENTATION_ENV_KEY = 'EXARCHOS_ORIENTATION' as const;

/**
 * Env var carrying the explicit authority marker for the orientation payload.
 * A well-behaved consumer reads {@link NON_AUTHORITATIVE} here and defers the
 * orientation to any user instruction rather than treating it as a directive.
 */
export const ORIENTATION_AUTHORITY_ENV_KEY = 'EXARCHOS_ORIENTATION_AUTHORITY' as const;

/**
 * Env var an authoritative directive channel would use — DISTINCT from the two
 * orientation keys. {@link injectOrientation} NEVER writes it: orientation
 * cannot masquerade as a directive.
 */
export const DIRECTIVE_ENV_KEY = 'EXARCHOS_DIRECTIVE' as const;

/** The placed authority marker value for a non-authoritative orientation payload. */
export const NON_AUTHORITATIVE = 'non-authoritative' as const;

/**
 * Build a non-authoritative orientation payload from opaque content. The tag
 * (`channel` + `authoritative`) is fixed by construction; content/format is #1485's.
 */
export function orientationPayload(content: string): OrientationPayload {
  return { channel: 'orientation', authoritative: false, content };
}

// ─── Compile-time tag invariants (gated by `tsc --noEmit`) ───────────────────
//
// `tsconfig.json` EXCLUDES `**/*.test.ts` from compilation, so a type-level
// assertion in the test file would NOT be gated by `tsc`. These invariants
// therefore live in this (compiled) source module. Each alias resolves to `true`
// when the tag holds and to `never` otherwise; assigning `true` to a `never`
// slot is the `tsc` error that fires if a tag ever collapses. The tuple is
// EXPORTED (so it is not dead code) and re-asserted at runtime in the test.

/** `true` iff the orientation channel discriminant is still `'orientation'`. */
type AssertOrientationChannel = OrientationPayload['channel'] extends 'orientation' ? true : never;

/** `true` iff orientation is still typed non-authoritative (`authoritative: false`). */
type AssertOrientationNonAuthoritative =
  OrientationPayload['authoritative'] extends false ? true : never;

/**
 * `true` iff the orientation and directive channels are DISTINCT — i.e. the
 * orientation discriminant does not extend the directive discriminant. Collapse
 * them (e.g. give orientation `channel: 'directive'`) and this becomes `never`.
 */
type AssertChannelsDistinct =
  OrientationPayload['channel'] extends DirectivePayload['channel'] ? never : true;

/**
 * The three tag invariants, proven at compile time. A green `tsc --noEmit` is
 * the real guarantee; the exported value is the runtime anchor the test pins.
 */
export const ORIENTATION_TAG_INVARIANTS: readonly [
  AssertOrientationChannel,
  AssertOrientationNonAuthoritative,
  AssertChannelsDistinct,
] = [true, true, true];

/**
 * Ephemerally inject an orientation payload into a spawn request's ENV channel —
 * with **NO repo-file mutation** (this function touches no filesystem at all).
 *
 * Returns a NEW request whose `env` additionally carries the orientation content
 * ({@link ORIENTATION_ENV_KEY}) and its non-authoritative authority marker
 * ({@link ORIENTATION_AUTHORITY_ENV_KEY}); the base request is never mutated and
 * {@link DIRECTIVE_ENV_KEY} is never written.
 *
 * Absent a payload (`undefined`), the base request is returned UNCHANGED — same
 * reference, so launch is byte-for-byte identical and adds zero env keys.
 *
 * Designed to slot into the placed spawn descriptor in the lifecycle integrator:
 * `injectOrientation({ ...descriptor, cwd: worktreePath }, orientation)`.
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

// ─── Resolved native injection channel (DR-6) + its spawn-descriptor applier ──
//
// The spawn-time probe (`lifecycle-core#resolveInjectionChannel`) narrows a
// harness's declarative candidate list to ONE {@link ResolvedInjectionChannel};
// {@link applyOrientationChannel} maps that resolved channel onto the placed
// spawn descriptor. Per-channel-KIND branching (`flag` / `env` / `none`) is a
// harness-AGNOSTIC dispatch on the candidate discriminant — never on a harness
// name — so the single-abstraction guard stays green.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The concrete native orientation channel the spawn-time probe selected for a
 * launch — a `flag`/`env` candidate the live CLI supports, or `none` (the CLI
 * exposes no channel / the probe failed). Carries the resolved candidate so the
 * applier maps the payload onto the exact flag/env the registry declared.
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
 * Injectable filesystem seams for the native-channel applier. The `file` flag
 * form (Claude Code `--append-system-prompt-file`) and the `dir` env form
 * (Copilot `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`) materialize the payload into an
 * ephemeral temp path; injecting these lets a test drive the construction path —
 * and force a construction FAILURE (DR-8 fail-open) — deterministically.
 */
export interface ChannelApplyDeps {
  /** Materialize orientation content into an ephemeral temp file; returns its path. Throws on failure. */
  readonly writeTempFile?: (content: string) => string;
  /** Materialize orientation content into an ephemeral temp dir (synthetic AGENTS.md); returns the dir. Throws on failure. */
  readonly writeTempDir?: (content: string) => string;
  /** Invoked with the ephemeral file/dir path once created, so the caller can schedule its removal. */
  readonly onTempPathCreated?: (path: string) => void;
}

/** Conservative headroom under typical ARG_MAX/env-size ceilings for inline injection. */
const MAX_INLINE_ORIENTATION_BYTES = 32 * 1024;

/** Throws if `content` is too large to place inline on argv/env (DR-8 fail-open trigger). */
function assertInlineSize(content: string): void {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_INLINE_ORIENTATION_BYTES) {
    throw new Error(
      `orientation content too large (${bytes} bytes) for inline flag/env injection`,
    );
  }
}

/**
 * Default `file`-form materializer: an ephemeral temp file holding the
 * orientation. `onCreated` fires right after `mkdtempSync`, BEFORE the
 * write that can fail (disk full, permissions) — so the caller can still
 * schedule the dir's removal even when the write itself throws, rather
 * than only on a fully successful materialization.
 */
function defaultWriteTempFile(content: string, onCreated?: (path: string) => void): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'exarchos-orient-'));
  onCreated?.(dir);
  const file = path.join(dir, 'orientation.md');
  writeFileSync(file, content, 'utf8');
  return file;
}

/** Default `dir`-form materializer: an ephemeral temp dir holding a synthetic
 * `AGENTS.md`. `onCreated` fires before the write, for the same reason as
 * {@link defaultWriteTempFile}. */
function defaultWriteTempDir(content: string, onCreated?: (path: string) => void): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'exarchos-orient-dir-'));
  onCreated?.(dir);
  writeFileSync(path.join(dir, 'AGENTS.md'), content, 'utf8');
  return dir;
}

/**
 * Apply a resolved native orientation channel to a placed spawn descriptor
 * (DR-6). Returns a NEW request; the base is never mutated and
 * {@link DIRECTIVE_ENV_KEY} is NEVER written (orientation cannot masquerade as a
 * directive — the refusal property {@link injectOrientation} owns is preserved
 * across every channel).
 *
 * For a `flag`/`env` channel the payload rides BOTH (a) the harness's native
 * channel (the flag args / env var the CLI itself consumes) and (b) the
 * file-free tagged {@link ORIENTATION_ENV_KEY} layer via {@link injectOrientation}
 * — this is the first production wiring of that seam, a uniform
 * non-authoritative marker regardless of the native channel. A `none` channel
 * applies nothing (the base is returned unchanged; the launch proceeds without
 * orientation — DR-8 fail-open).
 *
 * A `file`/`dir` construction failure THROWS (the caller fails open + records a
 * degradation); the pure `string`/`assignment`/`config-json` forms never do.
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

/** Derive the flag's argument from the payload per the candidate's `valueForm`. */
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
      // A caller-supplied writeTempFile owns its own path shape and failure
      // contract, so it is reported as-is, after it returns. The default
      // materializer instead reports its containing mkdtempSync dir BEFORE
      // the write that can fail, via onCreated — see defaultWriteTempFile.
      if (deps.writeTempFile) {
        const filePath = deps.writeTempFile(content);
        deps.onTempPathCreated?.(filePath);
        return filePath;
      }
      return defaultWriteTempFile(content, deps.onTempPathCreated);
    }
  }
}

/** Place the resolved env channel's payload-derived value on the spawn env. */
function applyEnvChannel(
  base: AsyncSpawnRequest,
  candidate: EnvInjectionCandidate,
  content: string,
  deps: ChannelApplyDeps,
): AsyncSpawnRequest {
  if (candidate.payload === 'config-json') {
    // The harness parses this var as ITS OWN config JSON, not a free-text
    // field — raw orientation prose is invalid content here. Materialize
    // orientation into a temp instruction file and reference it via the
    // harness's own instruction-file config key (see the
    // EnvInjectionCandidate.payload docstring — e.g. OpenCode's
    // `instructions: string[]`), so the var always carries valid JSON.
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

// ─── Orientation payload source: `binding/standard/block.md` (DR-6) ───────────

/** Repo-relative location of the runtime-neutral orientation block (one content source). */
const STANDARD_BLOCK_REL = path.join('binding', 'standard', 'block.md');

/**
 * Best-effort load of the runtime-neutral orientation payload from
 * `binding/standard/block.md` (DR-6's single content source). Walks up a bounded
 * number of ancestors from the module dir AND `process.cwd()`, returning the
 * first hit. Returns `undefined` on any failure — the fail-open signal the caller
 * turns into a no-orientation launch + degradation (never a throw).
 */
export function loadStandardBlockContent(searchRoots?: readonly string[]): string | undefined {
  for (const root of searchRoots ?? defaultBlockSearchRoots()) {
    let dir = root;
    for (let depth = 0; depth < 8; depth++) {
      try {
        return readFileSync(path.join(dir, STANDARD_BLOCK_REL), 'utf8');
      } catch {
        /* not at this ancestor — keep walking up. */
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

/** Search roots for {@link loadStandardBlockContent}: the module dir, then `process.cwd()`. */
function defaultBlockSearchRoots(): string[] {
  const roots: string[] = [];
  try {
    roots.push(path.dirname(fileURLToPath(import.meta.url)));
  } catch {
    /* import.meta.url unavailable (bundled edge) — fall through to cwd. */
  }
  roots.push(process.cwd());
  return roots;
}

/**
 * Preview (probe-free) the channel a real launch WOULD resolve to for a
 * candidate list — the FIRST (most-preferred) declared candidate, labelled like
 * {@link describeChannel}. Used by `--dry-run`, which must NOT spawn a help probe
 * (no side effects); the live spawn path re-resolves via the actual probe.
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
