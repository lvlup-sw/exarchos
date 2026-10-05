import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { AsyncSpawnRequest } from '../../../../src/utils/process.js';
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
} from '../../../../src/runtime/launcher/injection-seam.js';
import { HARNESS_DESCRIPTORS } from '../../../../src/runtime/launcher/harness-registry.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';

/** Lists each file path under `dir`, at any depth. */
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
    rmrf(repoDir);
  });

  /**
   * The repo dir is the cwd of the child, and it starts empty. The test lists its files before and
   * after the injection, so it catches a write through any `fs` import. The env assertion proves
   * that the injection ran, because a function that does nothing also writes nothing.
   */
  it('Injection_Payload_NoRepoWrite', () => {
    const before = listFilesDeep(repoDir);
    expect(before).toEqual([]);

    const base: AsyncSpawnRequest = { command: 'claude', args: [], cwd: repoDir, env: {} };
    const result = injectOrientation(base, orientationPayload('orient me'));

    expect(result.env?.[ORIENTATION_ENV_KEY]).toBe('orient me');

    expect(listFilesDeep(repoDir)).toEqual([]);
  });

  /**
   * The payload carries the `orientation` channel and `authoritative: false`, and it differs from
   * a directive payload. The injection writes the two orientation keys and never the directive
   * key. The exported type invariants and the `expectTypeOf` calls state the same tag as types.
   */
  it('Injection_TaggedNonAuthoritativeOrientation', () => {
    const payload = orientationPayload('some orientation');

    expect(payload.channel).toBe('orientation');
    expect(payload.authoritative).toBe(false);

    const directive: DirectivePayload = {
      channel: 'directive',
      authoritative: true,
      content: 'do this',
    };
    expect(payload.channel).not.toBe(directive.channel);
    expect(payload.authoritative).not.toBe(directive.authoritative);

    const base: AsyncSpawnRequest = { command: 'claude', args: [], cwd: '.', env: {} };
    const result = injectOrientation(base, payload);
    expect(result.env?.[ORIENTATION_ENV_KEY]).toBe('some orientation');
    expect(result.env?.[ORIENTATION_AUTHORITY_ENV_KEY]).toBe(NON_AUTHORITATIVE);
    expect(NON_AUTHORITATIVE).toBe('non-authoritative');
    expect(result.env?.[DIRECTIVE_ENV_KEY]).toBeUndefined();

    expect(ORIENTATION_ENV_KEY).not.toBe(DIRECTIVE_ENV_KEY);

    expect(ORIENTATION_TAG_INVARIANTS).toEqual([true, true, true]);
    expectTypeOf<OrientationPayload['channel']>().toEqualTypeOf<'orientation'>();
    expectTypeOf<OrientationPayload['authoritative']>().toEqualTypeOf<false>();
    expectTypeOf<OrientationPayload['channel']>().not.toEqualTypeOf<
      DirectivePayload['channel']
    >();
  });

  /** With no payload, the function returns the same request object and adds no env key. */
  it('Injection_Absent_LaunchUnchanged', () => {
    const base: AsyncSpawnRequest = {
      command: 'codex',
      args: ['--flag'],
      cwd: repoDir,
      env: { PRESET: 'keep' },
      stdio: 'inherit',
    };

    const result = injectOrientation(base, undefined);

    expect(result).toStrictEqual(base);
    expect(result).toBe(base);

    expect(result.env?.[ORIENTATION_ENV_KEY]).toBeUndefined();
    expect(result.env?.[ORIENTATION_AUTHORITY_ENV_KEY]).toBeUndefined();
    expect(result.env?.[DIRECTIVE_ENV_KEY]).toBeUndefined();
    expect(Object.keys(result.env ?? {})).toEqual(['PRESET']);
  });
});

/** The primary Claude Code flag candidate, with the `file` form. */
const CLAUDE_FILE = HARNESS_DESCRIPTORS['claude-code'].injection[0];
/** The fallback Claude Code flag candidate, with the `string` form. */
const CLAUDE_STRING = HARNESS_DESCRIPTORS['claude-code'].injection[1];
const CODEX_ASSIGN = HARNESS_DESCRIPTORS.codex.injection[0];
const COPILOT_ENV = HARNESS_DESCRIPTORS.copilot.injection[0];
const OPENCODE_ENV = HARNESS_DESCRIPTORS.opencode.injection[0];

/** Wraps a registry candidate as a `flag` resolved channel. Throws when the candidate is not a flag. */
function flagChannel(candidate: (typeof CLAUDE_FILE)): ResolvedInjectionChannel {
  if (candidate.kind !== 'flag') throw new Error('expected a flag candidate');
  return { kind: 'flag', candidate };
}

/** Wraps a registry candidate as an `env` resolved channel. Throws when the candidate is not `env`. */
function envChannel(candidate: (typeof COPILOT_ENV)): ResolvedInjectionChannel {
  if (candidate.kind !== 'env') throw new Error('expected an env candidate');
  return { kind: 'env', candidate };
}

describe('applyOrientationChannel — resolved native-channel applier (DR-6)', () => {
  const BASE: AsyncSpawnRequest = { command: 'claude', args: ['--pre'], cwd: '.', env: { KEEP: '1' } };

  /**
   * For each resolved channel, the applier never writes the directive key and never mutates the
   * base request. Thus orientation cannot pose as a directive. `injectOrientation` alone has the
   * same property.
   */
  it('injectOrientation_DirectiveKey_StillRefused', () => {
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
      expect(result.env?.[DIRECTIVE_ENV_KEY]).toBeUndefined();
      expect(result.args).not.toContain(DIRECTIVE_ENV_KEY);
      expect(BASE.args).toEqual(['--pre']);
    }

    const tagged = injectOrientation(BASE, orientationPayload(content));
    expect(tagged.env?.[ORIENTATION_ENV_KEY]).toBe(content);
    expect(tagged.env?.[DIRECTIVE_ENV_KEY]).toBeUndefined();
  });

  /**
   * The flag and the temp-file path follow the existing args, and the temp file gets the
   * orientation content. The tagged orientation env keys carry the content too.
   */
  it('applyFlagChannel_FileForm_WritesTempFileAndTagsEnv', () => {
    const captured: string[] = [];
    const writeTempFile = (c: string): string => {
      captured.push(c);
      return '/tmp/orient-abc/orientation.md';
    };
    const result = applyOrientationChannel(BASE, flagChannel(CLAUDE_FILE), 'BODY', {
      writeTempFile,
    });

    expect(result.args).toEqual(['--pre', '--append-system-prompt-file', '/tmp/orient-abc/orientation.md']);
    expect(captured).toEqual(['BODY']);
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

  /**
   * The size guard limits only inline placement on argv or env. The `config-json` form writes the
   * content to a temp file, as the `dir` form does, so oversized content does not throw.
   */
  it('applyEnvChannel_ConfigJsonForm_NoSizeGuard_ContentWritesToDiskRegardlessOfSize', () => {
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
    expect(result.args).toEqual(['--pre']);
  });

  /**
   * OpenCode parses `OPENCODE_CONFIG_CONTENT` as its own config JSON, so raw orientation prose is
   * not valid there. The applier must write the orientation to a file and name the file in the
   * `instructions` key. The var must hold JSON that parses.
   */
  it('applyEnvChannel_ConfigJsonForm_WritesTempFileAndReferencesItInInstructionsJson', () => {
    const result = applyOrientationChannel(BASE, envChannel(OPENCODE_ENV), 'JSON-BODY', {
      writeTempFile: () => '/tmp/orient-abc/orientation.md',
    });
    expect(result.env?.OPENCODE_CONFIG_CONTENT).toBe(
      JSON.stringify({ instructions: ['/tmp/orient-abc/orientation.md'] }),
    );
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

  /** `previewInjectionChannel` runs no probe, and it labels the first declared candidate. */
  it('describeChannel_and_previewInjectionChannel_LabelChannels', () => {
    expect(describeChannel(flagChannel(CLAUDE_FILE))).toBe('flag:--append-system-prompt-file');
    expect(describeChannel(envChannel(COPILOT_ENV))).toBe('env:COPILOT_CUSTOM_INSTRUCTIONS_DIRS');
    expect(describeChannel({ kind: 'none', reason: 'x' })).toBe('none');

    expect(previewInjectionChannel(HARNESS_DESCRIPTORS['claude-code'].injection)).toBe(
      'flag:--append-system-prompt-file',
    );
    expect(previewInjectionChannel(HARNESS_DESCRIPTORS.cursor.injection)).toBe('none');
    expect(previewInjectionChannel(HARNESS_DESCRIPTORS.opencode.injection)).toBe(
      'env:OPENCODE_CONFIG_CONTENT',
    );
  });
});
