import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { AsyncSpawnRequest } from '../../utils/process.js';
import {
  applyOrientationChannel,
  describeChannel,
  DIRECTIVE_ENV_KEY,
  injectOrientation,
  NON_AUTHORITATIVE,
  ORIENTATION_AUTHORITY_ENV_KEY,
  ORIENTATION_ENV_KEY,
  ORIENTATION_TAG_INVARIANTS,
  orientationPayload,
  previewInjectionChannel,
  type ChannelApplyDeps,
  type DirectivePayload,
  type OrientationPayload,
  type ResolvedInjectionChannel,
} from './injection-seam.js';
import { HARNESS_DESCRIPTORS } from './harness-registry.js';

/** Recursively list every file path under `dir` (empty when the dir is empty). */
function listFilesDeep(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFilesDeep(full));
    else out.push(full);
  }
  return out;
}

describe('injection-seam (DR-7)', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(path.join(os.tmpdir(), 'inj-seam-repo-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('Injection_Payload_NoRepoWrite', () => {
    // Snapshot the "repo" (the child's cwd) before injecting — it starts empty.
    // This filesystem-level guard catches any write under the repo regardless of
    // how the impl might reach `fs` (robust to ESM import style).
    const before = listFilesDeep(repoDir);
    expect(before).toEqual([]);

    // Inject a payload with the repo dir as the child's cwd.
    const base: AsyncSpawnRequest = { command: 'claude', args: [], cwd: repoDir, env: {} };
    const result = injectOrientation(base, orientationPayload('orient me'));

    // The injection actually happened (guards against a no-op that also writes
    // nothing) — the payload rode the ENV channel…
    expect(result.env?.[ORIENTATION_ENV_KEY]).toBe('orient me');

    // …yet NOTHING was written to disk: the repo dir is byte-for-byte unchanged.
    expect(listFilesDeep(repoDir)).toEqual([]);
  });

  it('Injection_TaggedNonAuthoritativeOrientation', () => {
    const payload = orientationPayload('some orientation');

    // ── Value-level tag: orientation, non-authoritative. ──────────────────────
    expect(payload.channel).toBe('orientation');
    expect(payload.authoritative).toBe(false);

    // ── Distinct from a directive channel (value level). ──────────────────────
    const directive: DirectivePayload = {
      channel: 'directive',
      authoritative: true,
      content: 'do this',
    };
    expect(payload.channel).not.toBe(directive.channel);
    expect(payload.authoritative).not.toBe(directive.authoritative);

    // ── Placement carries the tag: dedicated orientation keys + authority
    //    marker, and the DIRECTIVE key is never written (no masquerade). ───────
    const base: AsyncSpawnRequest = { command: 'claude', args: [], cwd: '.', env: {} };
    const result = injectOrientation(base, payload);
    expect(result.env?.[ORIENTATION_ENV_KEY]).toBe('some orientation');
    expect(result.env?.[ORIENTATION_AUTHORITY_ENV_KEY]).toBe(NON_AUTHORITATIVE);
    expect(NON_AUTHORITATIVE).toBe('non-authoritative');
    expect(result.env?.[DIRECTIVE_ENV_KEY]).toBeUndefined();

    // Orientation and directive env channels are distinct keys.
    expect(ORIENTATION_ENV_KEY).not.toBe(DIRECTIVE_ENV_KEY);

    // ── Type-level tag: gated by `tsc --noEmit` via the exported invariants,
    //    re-anchored here + expressed with expectTypeOf for documentation. ─────
    expect(ORIENTATION_TAG_INVARIANTS).toEqual([true, true, true]);
    expectTypeOf<OrientationPayload['channel']>().toEqualTypeOf<'orientation'>();
    expectTypeOf<OrientationPayload['authoritative']>().toEqualTypeOf<false>();
    expectTypeOf<OrientationPayload['channel']>().not.toEqualTypeOf<
      DirectivePayload['channel']
    >();
  });

  it('Injection_Absent_LaunchUnchanged', () => {
    const base: AsyncSpawnRequest = {
      command: 'codex',
      args: ['--flag'],
      cwd: repoDir,
      env: { PRESET: 'keep' },
      stdio: 'inherit',
    };

    const result = injectOrientation(base, undefined);

    // Params are unchanged — same value AND same reference (a true no-op).
    expect(result).toStrictEqual(base);
    expect(result).toBe(base);

    // No orientation/directive env keys were introduced.
    expect(result.env?.[ORIENTATION_ENV_KEY]).toBeUndefined();
    expect(result.env?.[ORIENTATION_AUTHORITY_ENV_KEY]).toBeUndefined();
    expect(result.env?.[DIRECTIVE_ENV_KEY]).toBeUndefined();
    expect(Object.keys(result.env ?? {})).toEqual(['PRESET']);
  });
});

// ─── Native-channel applier (DR-6) ────────────────────────────────────────────

/** The two Claude Code flag candidates (file primary, string fallback). */
const CLAUDE_FILE = HARNESS_DESCRIPTORS['claude-code'].injection[0];
const CLAUDE_STRING = HARNESS_DESCRIPTORS['claude-code'].injection[1];
const CODEX_ASSIGN = HARNESS_DESCRIPTORS.codex.injection[0];
const COPILOT_ENV = HARNESS_DESCRIPTORS.copilot.injection[0];
const OPENCODE_ENV = HARNESS_DESCRIPTORS.opencode.injection[0];

/** Narrow a registry candidate into a `flag` resolved channel (throws if not a flag). */
function flagChannel(candidate: (typeof CLAUDE_FILE)): ResolvedInjectionChannel {
  if (candidate.kind !== 'flag') throw new Error('expected a flag candidate');
  return { kind: 'flag', candidate };
}

/** Narrow a registry candidate into an `env` resolved channel (throws if not env). */
function envChannel(candidate: (typeof COPILOT_ENV)): ResolvedInjectionChannel {
  if (candidate.kind !== 'env') throw new Error('expected an env candidate');
  return { kind: 'env', candidate };
}

describe('applyOrientationChannel — resolved native-channel applier (DR-6)', () => {
  const BASE: AsyncSpawnRequest = { command: 'claude', args: ['--pre'], cwd: '.', env: { KEEP: '1' } };

  it('injectOrientation_DirectiveKey_StillRefused', () => {
    // Across EVERY resolved channel the applier NEVER writes the authoritative
    // DIRECTIVE key, and the orientation content never lands on it — orientation
    // cannot masquerade as a directive (the seam's refusal property, preserved
    // now that the seam has a live production caller).
    const content = 'ORIENT-PAYLOAD';
    const writeTempFile = (c: string): string => `/tmp/fake-orient/${c.length}`;
    const writeTempDir = (): string => '/tmp/fake-orient-dir';
    const deps: ChannelApplyDeps = { writeTempFile, writeTempDir };

    const channels: ResolvedInjectionChannel[] = [
      flagChannel(CLAUDE_FILE),
      flagChannel(CLAUDE_STRING),
      flagChannel(CODEX_ASSIGN),
      envChannel(COPILOT_ENV),
      envChannel(OPENCODE_ENV),
      { kind: 'none', reason: 'no channel' },
    ];

    for (const channel of channels) {
      const result = applyOrientationChannel(BASE, channel, content, deps);
      // The directive key is NEVER present…
      expect(result.env?.[DIRECTIVE_ENV_KEY]).toBeUndefined();
      // …and the payload never rode a directive arg either.
      expect(result.args).not.toContain(DIRECTIVE_ENV_KEY);
      // Base is never mutated (still its original two args).
      expect(BASE.args).toEqual(['--pre']);
    }

    // And bare injectOrientation still refuses the directive key directly.
    const tagged = injectOrientation(BASE, orientationPayload(content));
    expect(tagged.env?.[ORIENTATION_ENV_KEY]).toBe(content);
    expect(tagged.env?.[DIRECTIVE_ENV_KEY]).toBeUndefined();
  });

  it('applyFlagChannel_FileForm_WritesTempFileAndTagsEnv', () => {
    const captured: string[] = [];
    const writeTempFile = (c: string): string => {
      captured.push(c);
      return '/tmp/orient-abc/orientation.md';
    };
    const result = applyOrientationChannel(BASE, flagChannel(CLAUDE_FILE), 'BODY', {
      writeTempFile,
    });

    // The flag + the temp-file path are appended after the pre-existing args…
    expect(result.args).toEqual(['--pre', '--append-system-prompt-file', '/tmp/orient-abc/orientation.md']);
    // …the temp file received the orientation content…
    expect(captured).toEqual(['BODY']);
    // …and the file-free EXARCHOS_ORIENTATION tag rides alongside (defense-in-depth).
    expect(result.env?.[ORIENTATION_ENV_KEY]).toBe('BODY');
    expect(result.env?.[ORIENTATION_AUTHORITY_ENV_KEY]).toBe(NON_AUTHORITATIVE);
    expect(result.env?.KEEP).toBe('1');
  });

  it('applyFlagChannel_FileForm_NotifiesOnTempPathCreated', () => {
    const notified: string[] = [];
    const result = applyOrientationChannel(BASE, flagChannel(CLAUDE_FILE), 'BODY', {
      writeTempFile: () => '/tmp/orient-abc/orientation.md',
      onTempPathCreated: (p) => notified.push(p),
    });
    expect(notified).toEqual(['/tmp/orient-abc/orientation.md']);
    expect(result.args).toContain('/tmp/orient-abc/orientation.md');
  });

  it('applyEnvChannel_DirForm_NotifiesOnTempPathCreated', () => {
    const notified: string[] = [];
    applyOrientationChannel(BASE, envChannel(COPILOT_ENV), 'DIR-BODY', {
      writeTempDir: () => '/tmp/orient-dir',
      onTempPathCreated: (p) => notified.push(p),
    });
    expect(notified).toEqual(['/tmp/orient-dir']);
  });

  it('flagValue_StringOrAssignmentForm_ThrowsOverInlineSizeGuard', () => {
    const oversized = 'x'.repeat(33 * 1024);
    expect(() => applyOrientationChannel(BASE, flagChannel(CLAUDE_STRING), oversized)).toThrow(
      /orientation content too large/,
    );
    expect(() => applyOrientationChannel(BASE, flagChannel(CODEX_ASSIGN), oversized)).toThrow(
      /orientation content too large/,
    );
  });

  it('applyEnvChannel_ConfigJsonForm_NoSizeGuard_ContentWritesToDiskRegardlessOfSize', () => {
    // The size guard only bounds INLINE argv/env placement (E2BIG risk).
    // config-json materializes to a temp file, same as the dir form, so
    // oversized content is never placed inline and never throws here.
    const oversized = 'x'.repeat(33 * 1024);
    expect(() =>
      applyOrientationChannel(BASE, envChannel(OPENCODE_ENV), oversized, {
        writeTempFile: () => '/tmp/orient-abc/orientation.md',
      }),
    ).not.toThrow();
  });

  it('applyEnvChannel_DirForm_NoSizeGuard_ContentWritesToDiskRegardlessOfSize', () => {
    const oversized = 'x'.repeat(33 * 1024);
    expect(() =>
      applyOrientationChannel(BASE, envChannel(COPILOT_ENV), oversized, {
        writeTempDir: () => '/tmp/orient-dir',
      }),
    ).not.toThrow();
  });

  it('applyFlagChannel_StringForm_InlinesContentNoTempFile', () => {
    let wrote = false;
    const result = applyOrientationChannel(BASE, flagChannel(CLAUDE_STRING), 'INLINE-BODY', {
      writeTempFile: () => {
        wrote = true;
        return 'unused';
      },
    });

    expect(result.args).toEqual(['--pre', '--append-system-prompt', 'INLINE-BODY']);
    // The string form is pure — no temp file materialized.
    expect(wrote).toBe(false);
  });

  it('applyFlagChannel_AssignmentForm_EncodesAssignmentKey', () => {
    const result = applyOrientationChannel(BASE, flagChannel(CODEX_ASSIGN), 'CFG-BODY');
    expect(result.args).toEqual(['--pre', '-c', 'developer_instructions=CFG-BODY']);
  });

  it('applyEnvChannel_DirForm_PointsVarAtSyntheticDir', () => {
    const result = applyOrientationChannel(BASE, envChannel(COPILOT_ENV), 'DIR-BODY', {
      writeTempDir: () => '/tmp/orient-dir',
    });
    expect(result.env?.COPILOT_CUSTOM_INSTRUCTIONS_DIRS).toBe('/tmp/orient-dir');
    expect(result.env?.[ORIENTATION_ENV_KEY]).toBe('DIR-BODY');
    // No native flag args added for an env channel.
    expect(result.args).toEqual(['--pre']);
  });

  it('applyEnvChannel_ConfigJsonForm_WritesTempFileAndReferencesItInInstructionsJson', () => {
    // OpenCode parses OPENCODE_CONFIG_CONTENT as ITS OWN config JSON —
    // raw orientation prose is invalid content there. The applier must
    // materialize orientation to a file and reference it via the
    // harness's `instructions: string[]` config key instead of placing
    // the prose directly on the var.
    const result = applyOrientationChannel(BASE, envChannel(OPENCODE_ENV), 'JSON-BODY', {
      writeTempFile: () => '/tmp/orient-abc/orientation.md',
    });
    expect(result.env?.OPENCODE_CONFIG_CONTENT).toBe(
      JSON.stringify({ instructions: ['/tmp/orient-abc/orientation.md'] }),
    );
    // Sanity: the emitted var is itself valid, parseable JSON.
    expect(() => JSON.parse(result.env?.OPENCODE_CONFIG_CONTENT ?? '')).not.toThrow();
  });

  it('applyEnvChannel_ConfigJsonForm_NotifiesOnTempPathCreated', () => {
    const notified: string[] = [];
    applyOrientationChannel(BASE, envChannel(OPENCODE_ENV), 'JSON-BODY', {
      writeTempFile: () => '/tmp/orient-abc/orientation.md',
      onTempPathCreated: (p) => notified.push(p),
    });
    expect(notified).toEqual(['/tmp/orient-abc/orientation.md']);
  });

  it('applyOrientationChannel_None_ReturnsBaseUnchanged', () => {
    const result = applyOrientationChannel(BASE, { kind: 'none', reason: 'x' }, 'BODY');
    expect(result).toBe(BASE);
  });

  it('describeChannel_and_previewInjectionChannel_LabelChannels', () => {
    expect(describeChannel(flagChannel(CLAUDE_FILE))).toBe('flag:--append-system-prompt-file');
    expect(describeChannel(envChannel(COPILOT_ENV))).toBe('env:COPILOT_CUSTOM_INSTRUCTIONS_DIRS');
    expect(describeChannel({ kind: 'none', reason: 'x' })).toBe('none');

    // The probe-free dry-run preview names the PRIMARY declared candidate.
    expect(previewInjectionChannel(HARNESS_DESCRIPTORS['claude-code'].injection)).toBe(
      'flag:--append-system-prompt-file',
    );
    expect(previewInjectionChannel(HARNESS_DESCRIPTORS.cursor.injection)).toBe('none');
    expect(previewInjectionChannel(HARNESS_DESCRIPTORS.opencode.injection)).toBe(
      'env:OPENCODE_CONFIG_CONTENT',
    );
  });
});
