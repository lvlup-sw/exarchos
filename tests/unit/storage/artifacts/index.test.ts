import { createHash } from 'node:crypto';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as artifacts from '../../../../src/storage/artifacts/index.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function countFiles(root: string): Promise<number> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile()).length;
}

/**
 * The tests reach the store only through the barrel `index.js`, as a consumer
 * does. They prove that the barrel exports the public contract, and that the
 * store keeps its guarantees through the barrel.
 */
describe('artifacts packaged entry point', () => {
  it('PackagedArtifactSurface_ExportsPublicContract', () => {
    expect(typeof artifacts.ContentAddressedStore).toBe('function');
    expect(typeof artifacts.ContentAddressedStoreError).toBe('function');
    expect(typeof artifacts.ArtifactPathError).toBe('function');
    expect(typeof artifacts.assertSafeArtifactKey).toBe('function');
    expect(typeof artifacts.assertSafeArtifactSegment).toBe('function');
    expect(typeof artifacts.resolveContainedArtifactPath).toBe('function');
  });

  it('PackagedArtifactSurface_RoundTripAndGuarantees_ResolveConsumer', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'exarchos-cas-packaged-'));
    try {
      const store = new artifacts.ContentAddressedStore(root);
      const bytes = Buffer.from('packaged-consumer-payload', 'utf8');

      const digest = await store.put(bytes);
      expect(digest).toEqual({ algorithm: 'sha256', value: sha256Hex(bytes) });
      await expect(store.resolve(digest)).resolves.toEqual(bytes);

      const wrong = sha256Hex(Buffer.from('other'));
      await expect(
        store.put(bytes, { algorithm: 'sha256', value: wrong }),
      ).rejects.toBeInstanceOf(artifacts.ContentAddressedStoreError);

      await expect(
        store.resolve({ algorithm: 'sha256', value: '../../etc/passwd' }),
      ).rejects.toBeInstanceOf(artifacts.ContentAddressedStoreError);

      expect(await countFiles(root)).toBe(1);
    } finally {
      await rmrfAsync(root);
    }
  });

  it('PackagedArtifactSurface_PathContainment_RejectsHostileKeys', () => {
    for (const key of ['..', '/etc/passwd', 'C:\\Windows', '\\\\host\\share', 'a/../../b']) {
      let thrown: unknown;
      try {
        artifacts.assertSafeArtifactKey(key);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(artifacts.ArtifactPathError);
      expect((thrown as artifacts.ArtifactPathError).code).toBe('PATH_TRAVERSAL');
    }
  });
});
