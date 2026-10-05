/**
 * The vitest global setup gives each run one canonical temp root (#2027).
 *
 * The first case is the inheritance proof: vitest starts its workers after
 * the global setup, so `os.tmpdir()` in this worker is inside the root. The
 * other cases pin the parts of the setup: the root and its variables, the
 * sweep, and the teardown. A refused sweep reports in one line and does not
 * throw.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isInsideRunRoot, rmrf } from '../../tools/test-helpers/temp-dir.js';
import setupTempRunRoot, {
  RUN_ROOT_PREFIX,
  TEMP_VARIABLES,
  TEST_TMP_ROOT_ENV,
  createRunRoot,
  sweepRunRoot,
} from '../../tools/test-helpers/temp-run-root.js';

describe('temp run root (#2027)', () => {
  it('TempRunRoot_UnitWorker_TmpdirIsInsideTheRunRoot', () => {
    const runRoot = process.env[TEST_TMP_ROOT_ENV];

    expect(runRoot, 'the global setup did not give this worker a run root').toBeTruthy();
    expect(path.basename(runRoot ?? '').startsWith(RUN_ROOT_PREFIX)).toBe(true);
    expect(fs.realpathSync.native(runRoot ?? '')).toBe(runRoot);
    for (const name of TEMP_VARIABLES) expect(process.env[name], name).toBe(runRoot);
    expect(isInsideRunRoot(os.tmpdir(), runRoot)).toBe(true);
  });

  it('CreateRunRoot_PointsEveryTempVariableAtOneCanonicalRoot', () => {
    const env: NodeJS.ProcessEnv = {};
    const root = createRunRoot(env);
    try {
      expect(fs.statSync(root).isDirectory()).toBe(true);
      expect(fs.realpathSync.native(root)).toBe(root);
      expect(path.dirname(root)).toBe(fs.realpathSync.native(os.tmpdir()));
      expect(path.basename(root).startsWith(RUN_ROOT_PREFIX)).toBe(true);
      for (const name of [...TEMP_VARIABLES, TEST_TMP_ROOT_ENV]) expect(env[name], name).toBe(root);
    } finally {
      rmrf(root);
    }
  });

  it('SweepRunRoot_RemovesTheRootAndReportsNothing', () => {
    const root = createRunRoot({});
    fs.writeFileSync(path.join(root, 'left.txt'), 'x');

    expect(sweepRunRoot(root)).toBeUndefined();
    expect(fs.existsSync(root)).toBe(false);
  });

  it('SweepRunRoot_RefusedRemove_ReportsTheLeftoversInOneLine', () => {
    const root = createRunRoot({});
    try {
      fs.writeFileSync(path.join(root, 'held.db'), 'x');
      fs.mkdirSync(path.join(root, 'nested'));
      const remove = (): void => {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      };

      let report: string | undefined;
      expect(() => {
        report = sweepRunRoot(root, remove);
      }).not.toThrow();

      expect(report).toContain(root);
      expect(report).toContain('EBUSY');
      expect(report).toContain('2 entries left');
      expect(report).toContain('held.db');
      expect(report).not.toContain('\n');
    } finally {
      rmrf(root);
    }
  });

  it('SetupTempRunRoot_TeardownRestoresTheVariablesAndRemovesTheRoot', () => {
    const before = new Map([...TEMP_VARIABLES, TEST_TMP_ROOT_ENV].map((name) => [name, process.env[name]]));

    const teardown = setupTempRunRoot();
    const root = process.env[TEST_TMP_ROOT_ENV] ?? '';
    const insideDuringSetup = isInsideRunRoot(os.tmpdir(), root);
    teardown();

    expect(insideDuringSetup).toBe(true);
    expect(root).not.toBe(before.get(TEST_TMP_ROOT_ENV));
    expect(fs.existsSync(root)).toBe(false);
    for (const [name, value] of before) expect(process.env[name], name).toBe(value);
  });
});
