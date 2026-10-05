/**
 * Characterization pins for the onboarding reconciler: the field set of `ResolvedCommandsSchema`,
 * and the `DesiredState` that `detectDesiredState` returns for a fixture repo.
 *
 * The suite runs the real detector, resolver and schema over a temp-dir repo. The only stub is
 * `detectRuntimes`, because the real probe reads `$HOME` and makes `runtimes` depend on the host.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectDesiredState } from '../../../../../src/dispatch/core/onboarding/reconcile.js';
import {
  resolveTestRuntime,
  resolveVerificationRuntime,
} from '../../../../../src/config/test-runtime-resolver.js';
import {
  DesiredStateSchema,
  ResolvedCommandsSchema,
  type DesiredState,
} from '../../../../../src/dispatch/core/onboarding/types.js';
import { rmrf } from '../../../../../tools/test-helpers/temp-dir.js';

describe('reconcile characterization (T0 baseline)', () => {
  describe('ResolvedCommandsSchema_WidenedFields_Pinned', () => {
    /**
     * Every field is optional. The schema is a non-strict `z.object`, so it strips an unknown key
     * and does not reject the input.
     */
    it('accepts exactly {test?, typecheck?, install?, mutation?, lint?} and silently strips unknown keys', () => {
      const known = ResolvedCommandsSchema.safeParse({
        test: 'npm run test:run',
        typecheck: 'npm run typecheck',
        install: 'npm install',
        mutation: 'npx stryker run',
        lint: 'eslint .',
      });
      expect(known.success).toBe(true);
      if (known.success) {
        expect(known.data).toEqual({
          test: 'npm run test:run',
          typecheck: 'npm run typecheck',
          install: 'npm install',
          mutation: 'npx stryker run',
          lint: 'eslint .',
        });
      }

      const empty = ResolvedCommandsSchema.safeParse({});
      expect(empty.success).toBe(true);
      if (empty.success) {
        expect(empty.data).toEqual({});
      }

      const withExtra = ResolvedCommandsSchema.safeParse({
        test: 'npm run test:run',
        lint: 'npm run lint',
        unknownFutureField: 'whatever',
      });
      expect(withExtra.success).toBe(true);
      if (withExtra.success) {
        expect('unknownFutureField' in withExtra.data).toBe(false);
        expect(withExtra.data).toEqual({ test: 'npm run test:run', lint: 'npm run lint' });
      }

      const allFields = ResolvedCommandsSchema.parse({
        test: 't',
        typecheck: 'tc',
        install: 'i',
        mutation: 'm',
        lint: 'l',
      });
      expect(Object.keys(allFields).sort()).toEqual([
        'install',
        'lint',
        'mutation',
        'test',
        'typecheck',
      ]);
    });
  });

  describe('DetectDesiredState_FixtureRepo_CurrentShape', () => {
    let dir: string;

    /** A node repo with a `test:run` script and no `.git` entry, so `vcs` resolves to `none`. */
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'reconcile-char-'));
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({
          scripts: { 'test:run': 'vitest run', typecheck: 'tsc --noEmit' },
        }),
      );
    });

    afterEach(() => {
      rmrf(dir);
    });

    /**
     * The node toolchain seeds `mutation` with no config gate, so this bare fixture carries a
     * `mutation` command. Node seeds no `lint` command, so detection omits that key.
     *
     * Each command must also equal the resolver output for the same directory. That proves the
     * pinned shape is the resolver shape and not a transcription.
     */
    it('pins the full DesiredState shape for the fixture repo', async () => {
      const desired = await detectDesiredState(dir, { detectRuntimes: async () => [] });

      const parsed = DesiredStateSchema.safeParse(desired);
      expect(parsed.success).toBe(true);

      const expected: DesiredState = {
        runtimes: [],
        vcs: 'none',
        commands: {
          test: 'npm run test:run',
          typecheck: 'npm run typecheck',
          install: 'npm install',
          mutation: 'npx stryker run',
        },
      };
      expect(desired).toEqual(expected);

      const resolved = resolveTestRuntime(dir);
      expect(desired.commands.test).toBe(resolved.test ?? undefined);
      expect(desired.commands.typecheck).toBe(resolved.typecheck ?? undefined);
      expect(desired.commands.install).toBe(resolved.install ?? undefined);

      const verification = resolveVerificationRuntime(dir);
      expect(desired.commands.mutation).toBe(verification.mutation ?? undefined);
      expect('lint' in desired.commands).toBe(false);

      expect(Object.keys(desired).sort()).toEqual(['commands', 'runtimes', 'vcs']);
    });
  });
});
