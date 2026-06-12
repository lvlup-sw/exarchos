/**
 * T0 characterization (epic task 006, design §4.7) — PINS the CURRENT reconciler
 * shapes so the upcoming extension (a sibling task WIDENS `ResolvedCommandsSchema`
 * and adds a 13th doctor check) has a regression oracle.
 *
 * SCOPE — two pin surfaces:
 *   (a) `ResolvedCommandsSchema` field behavior: it currently accepts exactly
 *       `{test?, typecheck?, install?}` and SILENTLY STRIPS unknown keys (it does
 *       NOT reject — the plain `z.object` is non-strict). A sibling task that
 *       widens the schema (e.g. adds a `lint?` field, or makes it `.strict()`)
 *       trips THIS guard, forcing the change to be deliberate.
 *   (b) `detectDesiredState` output shape for a representative fixture repo: a
 *       temp dir with a `package.json` declaring a `test:run` script, run through
 *       the REAL resolver/detector path. The full `DesiredState` object is pinned
 *       snapshot-style.
 *
 * This test MUST PASS against unmodified HEAD — it is a Feathers baseline, not a
 * spec for new behavior.
 *
 * NO COPIED LITERALS MASQUERADING AS PINS: the `DesiredState` is produced by the
 * REAL `detectDesiredState` over a real temp-dir fixture (the same idiom as
 * `reconcile.detect.test.ts`); we re-parse it through the REAL `DesiredStateSchema`
 * loader before asserting. The only injection seam used is `detectRuntimes`
 * (stubbed to `[]`) — required for determinism, because the real agent-host probe
 * inspects `$HOME` and would make the fixture's `runtimes` host-dependent. The
 * command derivation and VCS detection run through the genuine resolver/fs paths.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectDesiredState } from './reconcile.js';
import { resolveTestRuntime } from '../../config/test-runtime-resolver.js';
import {
  DesiredStateSchema,
  ResolvedCommandsSchema,
  type DesiredState,
} from './types.js';

describe('reconcile characterization (T0 baseline)', () => {
  describe('ResolvedCommandsSchema_CurrentFields_Pinned', () => {
    it('accepts exactly {test?, typecheck?, install?} and silently strips unknown keys', () => {
      // All three known fields parse and round-trip unchanged.
      const known = ResolvedCommandsSchema.safeParse({
        test: 'npm run test:run',
        typecheck: 'npm run typecheck',
        install: 'npm install',
      });
      expect(known.success).toBe(true);
      if (known.success) {
        expect(known.data).toEqual({
          test: 'npm run test:run',
          typecheck: 'npm run typecheck',
          install: 'npm install',
        });
      }

      // Every field is OPTIONAL — the empty object is valid and yields {}.
      const empty = ResolvedCommandsSchema.safeParse({});
      expect(empty.success).toBe(true);
      if (empty.success) {
        expect(empty.data).toEqual({});
      }

      // PINNED CURRENT BEHAVIOR: an unknown key does NOT cause a parse failure —
      // the schema is the default (non-strict) z.object, which SILENTLY STRIPS
      // unknown keys rather than rejecting them. (A sibling task that adds a new
      // field, or switches to .strict(), changes this and trips the guard.)
      const withExtra = ResolvedCommandsSchema.safeParse({
        test: 'npm run test:run',
        lint: 'npm run lint',
        unknownFutureField: 'whatever',
      });
      expect(withExtra.success).toBe(true);
      if (withExtra.success) {
        // unknown keys stripped …
        expect('lint' in withExtra.data).toBe(false);
        expect('unknownFutureField' in withExtra.data).toBe(false);
        // … known key retained.
        expect(withExtra.data).toEqual({ test: 'npm run test:run' });
      }

      // The accepted field set is exactly these three (the shape's surface area).
      const allFields = ResolvedCommandsSchema.parse({
        test: 't',
        typecheck: 'tc',
        install: 'i',
      });
      expect(Object.keys(allFields).sort()).toEqual(['install', 'test', 'typecheck']);
    });
  });

  describe('DetectDesiredState_FixtureRepo_CurrentShape', () => {
    let dir: string;

    beforeEach(() => {
      // Representative fixture: a node repo declaring the `test:run` script the
      // resolver keys on. No `.git` materialized → vcs resolves to 'none'.
      dir = mkdtempSync(join(tmpdir(), 'reconcile-char-'));
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({
          scripts: { 'test:run': 'vitest run', typecheck: 'tsc --noEmit' },
        }),
      );
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('pins the full DesiredState shape for the fixture repo', async () => {
      // REAL detection path. Only `detectRuntimes` is stubbed (determinism — the
      // real probe reads $HOME); resolver + VCS detection are the genuine paths.
      const desired = await detectDesiredState(dir, { detectRuntimes: async () => [] });

      // The whole DesiredState satisfies the canonical schema (re-parse through
      // the REAL loader, not a hand-built literal).
      const parsed = DesiredStateSchema.safeParse(desired);
      expect(parsed.success).toBe(true);

      // Snapshot-style pin of the FULL object structure for this fixture.
      const expected: DesiredState = {
        runtimes: [],
        vcs: 'none',
        commands: {
          test: 'npm run test:run',
          typecheck: 'npm run typecheck',
          install: 'npm install',
        },
      };
      expect(desired).toEqual(expected);

      // Provenance: the commands came from the SAME resolver, not a parallel
      // derivation — proves the shape is the resolver's, not a transcription.
      const resolved = resolveTestRuntime(dir);
      expect(desired.commands.test).toBe(resolved.test ?? undefined);
      expect(desired.commands.typecheck).toBe(resolved.typecheck ?? undefined);
      expect(desired.commands.install).toBe(resolved.install ?? undefined);

      // Top-level key surface of DesiredState is exactly these three.
      expect(Object.keys(desired).sort()).toEqual(['commands', 'runtimes', 'vcs']);
    });
  });
});
