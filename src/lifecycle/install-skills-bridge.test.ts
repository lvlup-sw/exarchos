/**
 * Tests for `install-skills-bridge.js` runtimes resolution policy
 * (#1213 review-item #4 reversal, #1214).
 *
 * The bridge MUST prefer `EMBEDDED_RUNTIMES` by default — otherwise
 * the compiled binary fails at user-runtime with "Runtimes directory
 * not found" because the YAML files are not part of the bundled
 * artifact graph. The `EXARCHOS_RUNTIMES_FROM_DISK=1` override exists
 * solely for dev hot-reload; CI's `runtimes:guard` enforces drift.
 */
import { describe, it, expect, vi } from 'vitest';
import { runInstallSkills, shouldLoadFromDisk } from './install-skills-bridge.js';
import { EMBEDDED_RUNTIMES } from '../install/runtimes/embedded.js';
import { loadAllRuntimes } from '../install/runtimes/load.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Walk up from src/lifecycle → repo root.
const REPO_ROOT = resolve(__dirname, '../..');
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

  it('Bridge_EmbeddedAndDisk_ProduceIdenticalRuntimes', () => {
    const fromDisk = loadAllRuntimes(RUNTIMES_DIR);
    const fromEmbedded = [...EMBEDDED_RUNTIMES];

    // Order may differ (FS yields alphabetical via readdirSync().sort();
    // codegen yields REQUIRED_RUNTIME_NAMES order). Compare by name set
    // and by per-name field equality.
    const diskByName = new Map(fromDisk.map((r) => [r.name, r] as const));
    const embeddedByName = new Map(fromEmbedded.map((r) => [r.name, r] as const));

    expect(new Set(diskByName.keys())).toEqual(new Set(embeddedByName.keys()));

    for (const [name, diskRt] of diskByName) {
      const embeddedRt = embeddedByName.get(name);
      expect(embeddedRt, `embedded missing ${name}`).toBeDefined();
      // Deep-equal across the entire validated shape — the codegen
      // round-trip must not drop or transform any field.
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
