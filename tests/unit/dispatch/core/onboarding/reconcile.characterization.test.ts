/**
 * T0 characterization (epic task 006, design §4.7) — PINS the CURRENT reconciler
 * shapes so the upcoming extension (a sibling task WIDENS `ResolvedCommandsSchema`
 * and adds a 13th doctor check) has a regression oracle.
 *
 * SCOPE — two pin surfaces:
 *   (a) `ResolvedCommandsSchema` field behavior. DELIBERATE CONTRACT CHANGE
 *       (task 007, design §4.5-detect): the schema was WIDENED from the legacy
 *       `{test?, typecheck?, install?}` triple to the verification-ladder set
 *       `{test?, typecheck?, install?, mutation?, lint?}` so onboard/doctor
 *       resolve mutation/lint. This T0 pin originally caught that widening (it
 *       asserted `lint` was stripped); per the characterization protocol the
 *       intentional break was UPDATED here — see the in-test comment. The pin now
 *       guards the NEW five-field surface against accidental further drift.
 *   (b) `detectDesiredState` output shape for a representative fixture repo: a
 *       temp dir with a `package.json` declaring a `test:run` script, run through
 *       the REAL resolver/detector path. The full `DesiredState` object is pinned
 *       snapshot-style. This snapshot ALSO moved under task 007 — but for a
 *       registry reason, not a schema one: the node toolchain seeds `mutation`
 *       (`npx stryker run`) UNCONDITIONALLY, so widening detect to
 *       `resolveVerificationRuntime` adds a `mutation` key to this node fixture's
 *       `commands`. `lint` stays absent (node seeds no built-in lint) and
 *       `runtimes`/`vcs` are untouched. See the in-test comment.
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

describe('reconcile characterization (T0 baseline)', () => {
  describe('ResolvedCommandsSchema_WidenedFields_Pinned', () => {
    it('accepts exactly {test?, typecheck?, install?, mutation?, lint?} and silently strips unknown keys', () => {
      // DELIBERATE CHARACTERIZATION-PIN UPDATE (task 007, design §4.5-detect):
      // the T0 baseline pinned the legacy three-field surface and asserted `lint`
      // was STRIPPED. The widening makes `mutation` + `lint` first-class fields, so
      // this pin was updated to the NEW five-field surface — `lint` is now RETAINED
      // and `mutation` is accepted. Per the characterization protocol an intentional
      // contract break is UPDATED (this one); only an accidental break is a bug.

      // All five known fields parse and round-trip unchanged.
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

      // Every field is OPTIONAL — the empty object is valid and yields {}.
      const empty = ResolvedCommandsSchema.safeParse({});
      expect(empty.success).toBe(true);
      if (empty.success) {
        expect(empty.data).toEqual({});
      }

      // PINNED BEHAVIOR: a genuinely unknown key does NOT cause a parse failure —
      // the schema is the default (non-strict) z.object, which SILENTLY STRIPS
      // unknown keys rather than rejecting them. `lint` is now a KNOWN key (post
      // widening) and is retained; `unknownFutureField` remains unknown and stripped.
      const withExtra = ResolvedCommandsSchema.safeParse({
        test: 'npm run test:run',
        lint: 'npm run lint',
        unknownFutureField: 'whatever',
      });
      expect(withExtra.success).toBe(true);
      if (withExtra.success) {
        // unknown key stripped …
        expect('unknownFutureField' in withExtra.data).toBe(false);
        // … known keys (incl. the now-first-class `lint`) retained.
        expect(withExtra.data).toEqual({ test: 'npm run test:run', lint: 'npm run lint' });
      }

      // The accepted field set is exactly these five (the shape's surface area).
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
      //
      // REGISTRY-DRIVEN PIN UPDATE (task 007): widening detect to
      // `resolveVerificationRuntime` makes a node fixture surface its
      // registry-seeded `mutation` command (`npx stryker run`) — the node
      // toolchain seeds mutation UNCONDITIONALLY (no stryker-config gate). So even
      // this "bare package.json" fixture now carries a `mutation` key in
      // `commands`. `lint` stays absent (node has no built-in lint seed → null →
      // omitted), and `runtimes`/`vcs` are untouched.
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

      // Provenance: the legacy commands came from the SAME (delegated) resolver,
      // not a parallel derivation — proves the shape is the resolver's, not a
      // transcription. `resolveVerificationRuntime` delegates the legacy three to
      // `resolveTestRuntime` verbatim, so both agree.
      const resolved = resolveTestRuntime(dir);
      expect(desired.commands.test).toBe(resolved.test ?? undefined);
      expect(desired.commands.typecheck).toBe(resolved.typecheck ?? undefined);
      expect(desired.commands.install).toBe(resolved.install ?? undefined);

      // The mutation key likewise traces to the widened resolver (not fabricated).
      const verification = resolveVerificationRuntime(dir);
      expect(desired.commands.mutation).toBe(verification.mutation ?? undefined);
      expect('lint' in desired.commands).toBe(false);

      // Top-level key surface of DesiredState is exactly these three.
      expect(Object.keys(desired).sort()).toEqual(['commands', 'runtimes', 'vcs']);
    });
  });
});
