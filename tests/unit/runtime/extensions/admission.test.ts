import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  admitExtension,
  executeExtension,
  type AdmissionContext,
  type AdmissionRequest,
} from '../../../../src/runtime/extensions/admission.js';
import {
  ExtensionManifestBodyV1Schema,
  buildSignedManifest,
} from '../../../../src/runtime/extensions/manifest.js';
import {
  RevocationListBodyV1Schema,
  buildSignedRevocationList,
} from '../../../../src/runtime/extensions/revocation.js';
import { SIGNATURE_ALGORITHM, TrustRootSet } from '../../../../src/runtime/extensions/trust-root.js';
import { InMemoryVersionLedger } from '../../../../src/runtime/extensions/version-ledger.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

function makeSigner(keyId: string): {
  keyId: string;
  publicKeyPem: string;
  privateKeyPem: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { keyId, publicKeyPem: publicKey, privateKeyPem: privateKey };
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const NOW = 1_700_000_000_000;
const HORIZON = 60_000;

const trustedSigner = makeSigner('root.trusted');
const untrustedSigner = makeSigner('root.untrusted');

const trustRoots = new TrustRootSet([
  {
    keyId: trustedSigner.keyId,
    algorithm: SIGNATURE_ALGORITHM,
    publicKeyPem: trustedSigner.publicKeyPem,
  },
]);

const CONTENT = Buffer.from('valid extension code v2');
const DIGEST = { algorithm: 'sha256' as const, value: sha256Hex(CONTENT) };

const DEFAULT_QUOTA = {
  maxContentBytes: 1_000,
  maxMemoryBytes: 10_000,
  maxRuntimeMillis: 5_000,
  maxConcurrency: 2,
};

const BUDGET = ExtensionManifestBodyV1Schema.parse({
  schemaVersion: '1',
  extensionId: 'ext.demo',
  version: 0,
  contentDigest: DIGEST,
  quota: {
    maxContentBytes: 1_000,
    maxMemoryBytes: 100_000,
    maxRuntimeMillis: 60_000,
    maxConcurrency: 8,
  },
  isolation: { allowedCapabilities: [], filesystem: 'none', network: false },
}).quota;

const DEFAULT_BODY_INPUT: Record<string, unknown> = {
  schemaVersion: '1',
  extensionId: 'ext.demo',
  version: 2,
  contentDigest: DIGEST,
  quota: DEFAULT_QUOTA,
  isolation: { allowedCapabilities: ['fs:read'], filesystem: 'worktree', network: false },
};

function signManifest(
  overrides: Record<string, unknown> = {},
  who: { keyId: string; privateKeyPem: string } = trustedSigner,
) {
  const body = ExtensionManifestBodyV1Schema.parse({ ...DEFAULT_BODY_INPUT, ...overrides });
  return buildSignedManifest(body, { keyId: who.keyId, privateKeyPem: who.privateKeyPem });
}

function freshRevocationList(
  overrides: {
    issuedAt?: number;
    expiresAt?: number;
    revoked?: ReadonlyArray<{ extensionId: string; version?: number }>;
  } = {},
) {
  const body = RevocationListBodyV1Schema.parse({
    schemaVersion: '1',
    issuedAt: overrides.issuedAt ?? NOW - 1_000,
    expiresAt: overrides.expiresAt ?? NOW + 3_600_000,
    revoked: overrides.revoked ?? [],
  });
  return buildSignedRevocationList(body, trustedSigner);
}

function freshContext(over: Partial<AdmissionContext> = {}): AdmissionContext {
  return {
    trustRoots,
    revocationList: freshRevocationList(),
    quotaBudget: BUDGET,
    freshnessHorizonMillis: HORIZON,
    versionLedger: new InMemoryVersionLedger(),
    ...over,
  };
}

function request(
  manifest: unknown,
  loader: () => Promise<Buffer>,
  over: Partial<AdmissionRequest> = {},
): AdmissionRequest {
  return {
    manifest,
    loadContentOnce: loader,
    posture: 'task-isolated',
    nowMillis: NOW,
    ...over,
  };
}

describe('admitExtension — valid extension (P03-08)', () => {
  it('Admit_ValidExtension_AdmitsAndExecutesVerifiedBytes', async () => {
    const loader = vi.fn(async () => CONTENT);
    const outcome = await admitExtension(request(signManifest(), loader), freshContext());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.admitted.content.equals(CONTENT)).toBe(true);
    expect(loader).toHaveBeenCalledTimes(1);

    const run = vi.fn((content: Buffer) => content.toString('utf8'));
    const result = await executeExtension(outcome.admitted, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(result).toBe(CONTENT.toString('utf8'));
  });
});

describe('admitExtension — exit proof: fail closed before execution (P03-08)', () => {
  it('Admit_Untrusted_FailsClosed_ContentNeverLoaded', async () => {
    const loader = vi.fn(async () => CONTENT);
    const manifest = signManifest({}, untrustedSigner);
    const outcome = await admitExtension(request(manifest, loader), freshContext());

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.rejection.code).toBe('UNTRUSTED');
    expect(loader).not.toHaveBeenCalled();
  });

  /** The test changes the signed `version` field, so the signature does not match the manifest. */
  it('Admit_TamperedSignedField_FailsClosedUntrusted', async () => {
    const loader = vi.fn(async () => CONTENT);
    const signed = signManifest();
    const tampered = { ...signed, version: signed.version + 1 };
    const outcome = await admitExtension(request(tampered, loader), freshContext());

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.rejection.code).toBe('UNTRUSTED');
    expect(loader).not.toHaveBeenCalled();
  });

  it('Admit_Revoked_FailsClosed_ContentNeverLoaded', async () => {
    const loader = vi.fn(async () => CONTENT);
    const revocationList = freshRevocationList({ revoked: [{ extensionId: 'ext.demo' }] });
    const outcome = await admitExtension(
      request(signManifest(), loader),
      freshContext({ revocationList }),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.rejection.code).toBe('REVOKED');
    expect(loader).not.toHaveBeenCalled();
  });

  it('Admit_StaleRevocation_FailsClosed', async () => {
    const loader = vi.fn(async () => CONTENT);
    const revocationList = freshRevocationList({
      issuedAt: NOW - (HORIZON + 1),
      expiresAt: NOW + 3_600_000,
    });
    const outcome = await admitExtension(
      request(signManifest(), loader),
      freshContext({ revocationList }),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.rejection.code).toBe('STALE_REVOCATION');
    expect(loader).not.toHaveBeenCalled();
  });

  it('Admit_MissingRevocation_FailsClosed', async () => {
    const loader = vi.fn(async () => CONTENT);
    const outcome = await admitExtension(
      request(signManifest(), loader),
      freshContext({ revocationList: undefined }),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.rejection.code).toBe('STALE_REVOCATION');
    expect(loader).not.toHaveBeenCalled();
  });

  /** The ledger holds a high-water mark of 5, and the manifest declares version 2. */
  it('Admit_Rollback_FailsClosed_ContentNeverLoaded', async () => {
    const loader = vi.fn(async () => CONTENT);
    const ledger = new InMemoryVersionLedger();
    await ledger.recordAdmitted('ext.demo', 5);
    const outcome = await admitExtension(
      request(signManifest({ version: 2 }), loader),
      freshContext({ versionLedger: ledger }),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.rejection.code).toBe('ROLLBACK');
    expect(loader).not.toHaveBeenCalled();
  });

  /** The declared `maxMemoryBytes` of 200_000 exceeds the host budget of 100_000. */
  it('Admit_OverQuotaDeclared_FailsClosed_ContentNeverLoaded', async () => {
    const loader = vi.fn(async () => CONTENT);
    const manifest = signManifest({
      quota: { ...DEFAULT_QUOTA, maxMemoryBytes: 200_000 },
    });
    const outcome = await admitExtension(request(manifest, loader), freshContext());

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.rejection.code).toBe('OVER_QUOTA');
    expect(loader).not.toHaveBeenCalled();
  });

  /**
   * The declared content ceiling is inside the budget, but the content is larger than the ceiling.
   * Admission loads the content one time to measure it.
   */
  it('Admit_OverQuotaContent_FailsClosed_AfterLoad_NeverExecutes', async () => {
    const loader = vi.fn(async () => CONTENT);
    const manifest = signManifest({ quota: { ...DEFAULT_QUOTA, maxContentBytes: 5 } });
    const outcome = await admitExtension(request(manifest, loader), freshContext());

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.rejection.code).toBe('OVER_QUOTA');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  /** The manifest digest is for `CONTENT`, but the loader returns different bytes. */
  it('Admit_Mutated_FailsClosed_LoadedOnce_NeverExecutes', async () => {
    const loader = vi.fn(async () => Buffer.from('MUTATED extension bytes'));
    const outcome = await admitExtension(request(signManifest(), loader), freshContext());

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.rejection.code).toBe('MUTATED');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('Admit_ContentLoaderThrows_FailsClosed', async () => {
    const loader = vi.fn(async () => {
      throw new Error('disk gone');
    });
    const outcome = await admitExtension(request(signManifest(), loader), freshContext());

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.rejection.code).toBe('CONTENT_UNAVAILABLE');
  });

  it('Admit_MalformedManifest_FailsClosed', async () => {
    const loader = vi.fn(async () => CONTENT);
    const outcome = await admitExtension(
      request({ not: 'a manifest' }, loader),
      freshContext(),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.rejection.code).toBe('MALFORMED_MANIFEST');
    expect(loader).not.toHaveBeenCalled();
  });

  /** The `read-only` posture does not grant `shell:exec`. */
  it('Admit_IsolationEscalation_FailsClosed', async () => {
    const loader = vi.fn(async () => CONTENT);
    const manifest = signManifest({
      isolation: { allowedCapabilities: ['shell:exec'], filesystem: 'none', network: false },
    });
    const outcome = await admitExtension(
      request(manifest, loader, { posture: 'read-only' }),
      freshContext(),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.rejection.code).toBe('ISOLATION_VIOLATION');
    expect(loader).not.toHaveBeenCalled();
  });

  /**
   * A rejected outcome carries no admitted extension. Thus no caller can pass a rejected
   * extension to `executeExtension`.
   */
  it('Admit_RejectedOutcome_ExposesNoAdmittedExtension', async () => {
    const loader = vi.fn(async () => CONTENT);
    const outcome = await admitExtension(
      request(signManifest({}, untrustedSigner), loader),
      freshContext(),
    );
    expect(outcome.ok).toBe(false);
    expect('admitted' in outcome).toBe(false);
  });
});

describe('admitExtension — TOCTOU resistance (P03-08)', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rmrfAsync(dir);
  });

  /**
   * The loader reads the file one time. The test then changes the file on disk, after
   * verification and before execution. Execution must run the verified bytes in memory.
   */
  it('Admit_TOCTOU_MutationAfterVerify_ExecutesVerifiedBytesNotMutated', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ext-toctou-'));
    const file = path.join(dir, 'extension.bin');
    await writeFile(file, CONTENT);

    const loader = vi.fn(async () => readFile(file));
    const outcome = await admitExtension(request(signManifest(), loader), freshContext());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(loader).toHaveBeenCalledTimes(1);

    await writeFile(file, Buffer.from('MALICIOUS replacement bytes'));

    const executed = await executeExtension(outcome.admitted, (content) => content);
    expect(executed.equals(CONTENT)).toBe(true);
    expect(outcome.admitted.content.equals(CONTENT)).toBe(true);
  });
});

describe('admitExtension — anti-rollback ledger (P03-08)', () => {
  /**
   * After the admission of version 2, a lower version is a rollback. An equal version is
   * admissible again, and a higher version advances the high-water mark.
   */
  it('Admit_LedgerAdvances_RejectsLowerAllowsEqualAndHigher', async () => {
    const context = freshContext();

    const first = await admitExtension(
      request(signManifest({ version: 2 }), async () => CONTENT),
      context,
    );
    expect(first.ok).toBe(true);

    const lower = await admitExtension(
      request(signManifest({ version: 1 }), async () => CONTENT),
      context,
    );
    expect(lower.ok).toBe(false);
    if (!lower.ok) expect(lower.rejection.code).toBe('ROLLBACK');

    const equal = await admitExtension(
      request(signManifest({ version: 2 }), async () => CONTENT),
      context,
    );
    expect(equal.ok).toBe(true);

    const higher = await admitExtension(
      request(signManifest({ version: 3 }), async () => CONTENT),
      context,
    );
    expect(higher.ok).toBe(true);
    expect(await context.versionLedger.highestAdmitted('ext.demo')).toBe(3);
  });
});
