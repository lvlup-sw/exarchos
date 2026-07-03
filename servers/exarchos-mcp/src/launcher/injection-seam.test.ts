import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { AsyncSpawnRequest } from '../utils/process.js';
import {
  DIRECTIVE_ENV_KEY,
  injectOrientation,
  NON_AUTHORITATIVE,
  ORIENTATION_AUTHORITY_ENV_KEY,
  ORIENTATION_ENV_KEY,
  ORIENTATION_TAG_INVARIANTS,
  orientationPayload,
  type DirectivePayload,
  type OrientationPayload,
} from './injection-seam.js';

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
