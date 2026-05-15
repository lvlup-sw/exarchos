import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { withTmpHome } from './tmp-home.js';

describe('withTmpHome', () => {
  it('TmpHome_CreatesIsolatedHomeDir_AndCleansUpOnDispose', async () => {
    const priorHome = process.env.HOME;
    let observedHome: string | undefined;

    await withTmpHome(async (home) => {
      observedHome = home;
      // home must be absolute
      expect(path.isAbsolute(home)).toBe(true);
      // process.env.HOME must equal the tmpdir during callback
      expect(process.env.HOME).toBe(home);
      // tmpdir must exist during callback
      expect(fs.existsSync(home)).toBe(true);
    });

    // HOME must be restored after callback
    expect(process.env.HOME).toBe(priorHome);
    // tmpdir must be deleted after callback
    expect(observedHome).toBeDefined();
    expect(fs.existsSync(observedHome as string)).toBe(false);
  });
});
