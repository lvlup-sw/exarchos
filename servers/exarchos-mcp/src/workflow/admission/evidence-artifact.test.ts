import { mkdir, mkdtemp, open, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ContentAddressedStore,
  type ContentAddressedStoreIo,
} from '../../storage/artifacts/content-addressed-store.js';
import { publishTempFile } from '../../utils/atomic-write.js';
import {
  EvidenceArtifactResolutionError,
  resolveEvidenceArtifact,
  storeEvidenceArtifact,
} from './evidence-artifact.js';
import { normalizeEvidenceSubjectContent } from './evidence-subject.js';

/** Real filesystem IO whose publish rename always fails — simulates a crash
 * between staging the temp file and promoting it over the target. */
function failingPublishIo(): ContentAddressedStoreIo {
  return {
    mkdir: (directory, options) => mkdir(directory, options),
    writeFile: async (file, data) => {
      const handle = await open(file, 'wx');
      try {
        await handle.writeFile(data);
      } finally {
        await handle.close();
      }
    },
    readFile: (file) => readFile(file),
    publish: (temporary, target) =>
      publishTempFile(temporary, target, {
        rename: () => {
          throw Object.assign(new Error('injected publish failure'), {
            code: 'EINJECT',
          });
        },
        unlink: (file: string) => unlink(file),
      }),
    unlink: (file) => unlink(file),
  };
}

async function onlyStoredBlob(root: string): Promise<string> {
  const algorithmDirectories = await readdir(root);
  expect(algorithmDirectories).toEqual(['sha256']);
  const prefixDirectories = await readdir(path.join(root, 'sha256'));
  expect(prefixDirectories).toHaveLength(1);
  const files = await readdir(
    path.join(root, 'sha256', prefixDirectories[0]!),
  );
  expect(files).toHaveLength(1);
  return path.join(root, 'sha256', prefixDirectories[0]!, files[0]!);
}

describe('content-addressed evidence artifacts', () => {
  let artifactRoot: string;
  let store: ContentAddressedStore;

  beforeEach(async () => {
    artifactRoot = await mkdtemp(path.join(tmpdir(), 'exarchos-evidence-'));
    store = new ContentAddressedStore(artifactRoot);
  });

  afterEach(async () => {
    await rm(artifactRoot, { recursive: true, force: true });
  });

  it('EvidenceArtifact_RoundTrip_PreservesCanonicalContent', async () => {
    await fc.assert(
      fc.asyncProperty(fc.jsonValue(), async (report) => {
        const reference = await storeEvidenceArtifact(
          store,
          { kind: 'artifact', artifactId: 'gate-report-001' },
          report,
          { mediaType: 'application/json' },
        );

        await expect(resolveEvidenceArtifact(store, reference)).resolves.toEqual(
          normalizeEvidenceSubjectContent(report),
        );
        expect(Object.isFrozen(reference)).toBe(true);
        expect(Object.isFrozen(reference.subject)).toBe(true);
        expect(Object.isFrozen(reference.subject.digest)).toBe(true);
      }),
      { numRuns: 30 },
    );
  });

  it('EvidenceArtifact_DigestMismatch_IsRejected', async () => {
    const reference = await storeEvidenceArtifact(
      store,
      { kind: 'artifact', artifactId: 'gate-report-002' },
      { passed: true, details: ['checked'] },
      { mediaType: 'application/json' },
    );
    const blobPath = await onlyStoredBlob(artifactRoot);
    await writeFile(blobPath, '{"corrupted":true}', 'utf8');

    await expect(resolveEvidenceArtifact(store, reference)).rejects.toEqual(
      expect.objectContaining({
        name: 'EvidenceArtifactResolutionError',
        code: 'DIGEST_MISMATCH',
      }),
    );
  });

  it('EvidenceArtifact_MissingContent_IsRejectedExplicitly', async () => {
    const reference = await storeEvidenceArtifact(
      store,
      { kind: 'artifact', artifactId: 'gate-report-003' },
      { summary: 'stored out of band' },
      { mediaType: 'application/json' },
    );
    await unlink(await onlyStoredBlob(artifactRoot));

    await expect(resolveEvidenceArtifact(store, reference)).rejects.toEqual(
      expect.objectContaining({
        name: 'EvidenceArtifactResolutionError',
        code: 'CONTENT_NOT_FOUND',
      }),
    );
  });

  it('EvidenceArtifact_CanonicalEquivalence_UsesOneIdentity', async () => {
    const identity = {
      kind: 'artifact',
      artifactId: 'gate-report-canonical',
    } as const;
    const first = await storeEvidenceArtifact(
      store,
      identity,
      { z: 'Cafe\u0301\r\nline', a: { y: 2, x: 1 } },
      { mediaType: 'application/json' },
    );
    const equivalent = await storeEvidenceArtifact(
      store,
      identity,
      { a: { x: 1, y: 2 }, z: 'Café\nline' },
      { mediaType: 'application/json' },
    );

    expect(equivalent).toEqual(first);
    expect(await onlyStoredBlob(artifactRoot)).toBeTruthy();
    await expect(resolveEvidenceArtifact(store, first)).resolves.toEqual({
      a: { x: 1, y: 2 },
      z: 'Café\nline',
    });
  });

  it('EvidenceArtifact_ValidBlobForDifferentSubject_IsRejected', async () => {
    const first = await storeEvidenceArtifact(
      store,
      { kind: 'artifact', artifactId: 'gate-report-first' },
      { report: 'first' },
      { mediaType: 'application/json' },
    );
    const second = await storeEvidenceArtifact(
      store,
      { kind: 'artifact', artifactId: 'gate-report-second' },
      { report: 'second' },
      { mediaType: 'application/json' },
    );
    const mismatched = {
      ...first,
      subject: { ...first.subject, digest: second.subject.digest },
      byteLength: second.byteLength,
    };

    await expect(resolveEvidenceArtifact(store, mismatched)).rejects.toEqual(
      expect.objectContaining({ code: 'DIGEST_MISMATCH' }),
    );
  });

  it('EvidenceArtifact_ReferencesRemainCompactAndRejectMalformedInput', async () => {
    const marker = 'large-report-content-must-not-enter-events';
    const reference = await storeEvidenceArtifact(
      store,
      { kind: 'artifact', artifactId: 'gate-report-compact' },
      { report: marker.repeat(20_000) },
      { mediaType: 'application/json' },
    );

    const eventPayload = JSON.stringify({ artifact: reference });
    expect(eventPayload).not.toContain(marker);
    expect(eventPayload.length).toBeLessThan(500);
    expect(reference).toEqual({
      contractVersion: '1.0',
      subject: expect.objectContaining({
        kind: 'artifact',
        artifactId: 'gate-report-compact',
        digest: {
          algorithm: 'sha256',
          value: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      }),
      mediaType: 'application/json',
      byteLength: expect.any(Number),
    });

    const unsupported = {
      ...reference,
      subject: {
        ...reference.subject,
        digest: { algorithm: 'sha512', value: reference.subject.digest.value },
      },
    };
    const malformed = {
      ...reference,
      subject: {
        ...reference.subject,
        digest: { algorithm: 'sha256', value: 'not-a-digest' },
      },
    };

    await expect(resolveEvidenceArtifact(store, unsupported)).rejects.toEqual(
      expect.objectContaining({ code: 'UNSUPPORTED_DIGEST_ALGORITHM' }),
    );
    await expect(resolveEvidenceArtifact(store, malformed)).rejects.toEqual(
      expect.objectContaining({ code: 'MALFORMED_REFERENCE' }),
    );
    await expect(resolveEvidenceArtifact(store, null)).rejects.toBeInstanceOf(
      EvidenceArtifactResolutionError,
    );
  });

  it('EvidenceArtifact_StoreDetectsPersistedCorruptionWithoutReturningBytes', async () => {
    const reference = await storeEvidenceArtifact(
      store,
      { kind: 'artifact', artifactId: 'gate-report-corruption' },
      { checks: ['typecheck', 'test'] },
      { mediaType: 'application/json' },
    );
    const blobPath = await onlyStoredBlob(artifactRoot);
    const original = await readFile(blobPath);
    original[0] = original[0]! ^ 1;
    await writeFile(blobPath, original);

    await expect(resolveEvidenceArtifact(store, reference)).rejects.toMatchObject({
      code: 'DIGEST_MISMATCH',
    });
  });

  it('EvidenceArtifact_PartialPublishFailure_LeavesNoResolvableArtifact', async () => {
    const failing = new ContentAddressedStore(artifactRoot, failingPublishIo());

    await expect(
      storeEvidenceArtifact(
        failing,
        { kind: 'artifact', artifactId: 'gate-report-partial' },
        { verdict: 'pass', evidence: ['a', 'b'] },
        { mediaType: 'application/json' },
      ),
    ).rejects.toThrow('injected publish failure');

    // Nothing was published, so nothing — complete or partial — is readable,
    // and no staged temp file was left behind.
    const entries = await readdir(artifactRoot, {
      withFileTypes: true,
      recursive: true,
    });
    expect(entries.filter((entry) => entry.isFile())).toEqual([]);
  });

  it('EvidenceArtifact_PartialPublishFailure_PreservesPriorArtifact', async () => {
    const identity = {
      kind: 'artifact',
      artifactId: 'gate-report-prior',
    } as const;
    const content = { verdict: 'pass', evidence: ['prior'] };
    const reference = await storeEvidenceArtifact(store, identity, content, {
      mediaType: 'application/json',
    });

    const failing = new ContentAddressedStore(artifactRoot, failingPublishIo());
    await expect(
      storeEvidenceArtifact(failing, identity, content, {
        mediaType: 'application/json',
      }),
    ).rejects.toThrow('injected publish failure');

    // The previously published evidence still resolves and verifies.
    await expect(resolveEvidenceArtifact(store, reference)).resolves.toEqual(
      normalizeEvidenceSubjectContent(content),
    );
  });

  it('EvidenceArtifact_ConcurrentStores_ResolveToOneCanonicalArtifact', async () => {
    const identity = {
      kind: 'artifact',
      artifactId: 'gate-report-concurrent',
    } as const;
    const content = { verdict: 'pass', checks: ['typecheck', 'test'] };

    const references = await Promise.all(
      Array.from({ length: 12 }, () =>
        storeEvidenceArtifact(store, identity, content, {
          mediaType: 'application/json',
        }),
      ),
    );

    // Every concurrent writer produced the identical content-addressed reference.
    for (const reference of references) {
      expect(reference).toEqual(references[0]);
    }
    // Exactly one canonical blob survived the collision, and it resolves.
    expect(await onlyStoredBlob(artifactRoot)).toBeTruthy();
    await expect(resolveEvidenceArtifact(store, references[0]!)).resolves.toEqual(
      normalizeEvidenceSubjectContent(content),
    );
  });
});
