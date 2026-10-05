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
      expect(path.isAbsolute(home)).toBe(true);
      expect(process.env.HOME).toBe(home);
      expect(fs.existsSync(home)).toBe(true);
    });

    expect(process.env.HOME).toBe(priorHome);
    expect(observedHome).toBeDefined();
    expect(fs.existsSync(observedHome as string)).toBe(false);
  });
});
