/**
 * Tests for the runtime-selection policy of `install-skills-bridge.js`.
 *
 * The bridge uses `EMBEDDED_RUNTIMES` by default, because the compiled binary does not contain
 * the runtime YAML files. `EXARCHOS_RUNTIMES_FROM_DISK=1` loads the YAML from disk for development.
 */
import { describe, it, expect, vi } from 'vitest';
import { runInstallSkills, shouldLoadFromDisk } from '../../../src/lifecycle/install-skills-bridge.js';
import { EMBEDDED_RUNTIMES } from '../../../src/install/runtimes/embedded.js';
import { loadAllRuntimes } from '../../../src/install/runtimes/load.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** The repository root, three directories up from this test directory. */
const REPO_ROOT = resolve(__dirname, '../../..');
const RUNTIMES_DIR = resolve(REPO_ROOT, 'content/harness/runtimes');

describe('install-skills-bridge', () => {
  it('Bridge_Default_UsesEmbeddedRuntimes', async () => {
    const installer = vi.fn(async () => {});
    await runInstallSkills(
      { agent: 'generic' },
      {
        env: {},
        installer,
        loadFromDisk: vi.fn(() => {
          throw new Error('FS path must not run when env var is unset');
        }),
      },
    );
    expect(installer).toHaveBeenCalledTimes(1);
    const callArg = installer.mock.calls[0]?.[0];
    expect(callArg?.runtimes).toBe(EMBEDDED_RUNTIMES);
  });

  it('Bridge_DiskFlagSet_LoadsFromFilesystem', async () => {
    const installer = vi.fn(async () => {});
    const fakeRuntimes = [{ name: 'fake' } as never];
    const loadFromDisk = vi.fn(() => fakeRuntimes);
    await runInstallSkills(
      { agent: 'fake' },
      {
        env: { EXARCHOS_RUNTIMES_FROM_DISK: '1' } as NodeJS.ProcessEnv,
        installer,
        loadFromDisk,
      },
    );
    expect(loadFromDisk).toHaveBeenCalledTimes(1);
    expect(installer).toHaveBeenCalledTimes(1);
    const callArg = installer.mock.calls[0]?.[0];
    expect(callArg?.runtimes).toBe(fakeRuntimes);
  });

  /**
   * The test compares the runtimes by name, so the order of each source has no effect.
   * The codegen must not drop or change a field: each embedded runtime must deep-equal its disk runtime.
   */
  it('Bridge_EmbeddedAndDisk_ProduceIdenticalRuntimes', () => {
    const fromDisk = loadAllRuntimes(RUNTIMES_DIR);
    const fromEmbedded = [...EMBEDDED_RUNTIMES];

    const diskByName = new Map(fromDisk.map((r) => [r.name, r] as const));
    const embeddedByName = new Map(fromEmbedded.map((r) => [r.name, r] as const));

    expect(new Set(diskByName.keys())).toEqual(new Set(embeddedByName.keys()));

    for (const [name, diskRt] of diskByName) {
      const embeddedRt = embeddedByName.get(name);
      expect(embeddedRt, `embedded missing ${name}`).toBeDefined();
      expect(embeddedRt).toEqual(diskRt);
    }
  });

  it('shouldLoadFromDisk_OnlyTrueWhenEnvVarIsExactlyOne', () => {
    expect(shouldLoadFromDisk({})).toBe(false);
    expect(shouldLoadFromDisk({ EXARCHOS_RUNTIMES_FROM_DISK: '0' } as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldLoadFromDisk({ EXARCHOS_RUNTIMES_FROM_DISK: 'true' } as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldLoadFromDisk({ EXARCHOS_RUNTIMES_FROM_DISK: '1' } as NodeJS.ProcessEnv)).toBe(true);
  });
});
