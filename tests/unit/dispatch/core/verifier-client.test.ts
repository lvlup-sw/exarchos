/**
 * In-process fixtures of `loadVerifierProvisioning`. Each case writes a real provisioning tree in a private temporary directory.
 * Only an ENOENT result of the first `lstat` means that the machine has no verifier. Every other refusal gives an unusable connector.
 * A usable read passes the top-level resource and profile identities with no change to their bytes.
 */

import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadVerifierProvisioning } from '../../../../src/dispatch/core/verifier-client.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';

/** The roots that the running case made. The teardown removes them. */
const roots: string[] = [];

/** A private root for one case, in canonical form. */
function privateRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'verifier-client-')));
  roots.push(root);
  return root;
}

/** The public key of a fresh Ed25519 verifier signer, as PEM. */
function verifierPublicKey(): string {
  return generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
}

/** A private 0700 provisioning directory under `root` with a 0600 token file. It returns the directory and the token path. */
function provisioningDirectory(root: string): { readonly directory: string; readonly tokenPath: string } {
  const directory = join(root, 'verifier');
  mkdirSync(directory, { mode: 0o700 });
  chmodSync(directory, 0o700);
  const tokenPath = join(directory, 'token');
  writeFileSync(tokenPath, 't'.repeat(48), { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
  return { directory, tokenPath };
}

/** Write a 0600 client file with the given body into `directory`, and return its path. */
function clientFile(directory: string, body: unknown): string {
  const path = join(directory, 'client.json');
  writeFileSync(path, JSON.stringify(body), { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/** A complete client body that the strict schema accepts. */
function clientBody(directory: string, tokenPath: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    socketPath: join(directory, 'verifier.sock'),
    tokenPath,
    publicKey: verifierPublicKey(),
    gitPath: '/usr/bin/git',
    resourceId: 'resource',
    profileId: 'profile',
    ...overrides,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmrf(root);
});

describe('loadVerifierProvisioning', () => {
  /** A missing file and a missing parent directory both give ENOENT, so both mean that the machine has no verifier. */
  it('LoadVerifierProvisioning_EnoentOnly_IsAbsent', async () => {
    const root = privateRoot();

    expect(await loadVerifierProvisioning(join(root, 'client.json'))).toEqual({ kind: 'absent' });
    expect(await loadVerifierProvisioning(join(root, 'missing', 'client.json'))).toEqual({ kind: 'absent' });
  });

  /** A path whose parent is a regular file gives ENOTDIR. That is not ENOENT, so the connector is unusable and never absent. */
  it('LoadVerifierProvisioning_Enotdir_IsUnusableNotAbsent', async ({ skip }) => {
    if (process.platform === 'win32') return skip();
    const root = privateRoot();
    writeFileSync(join(root, 'file'), 'not a directory');

    const outcome = await loadVerifierProvisioning(join(root, 'file', 'client.json'));

    expect(outcome.kind).toBe('unusable');
  });

  /** A client file that is a link to a missing target exists for `lstat`, so it is not absent. It is not a regular file, so it is unusable. */
  it('LoadVerifierProvisioning_DanglingFileLink_IsUnusable', async ({ skip }) => {
    if (process.platform !== 'linux') return skip();
    const root = privateRoot();
    const { directory } = provisioningDirectory(root);
    const path = join(directory, 'client.json');
    symlinkSync(join(directory, 'missing.json'), path);

    const outcome = await loadVerifierProvisioning(path);

    expect(outcome.kind).toBe('unusable');
    if (outcome.kind !== 'unusable') throw new Error('expected an unusable provisioning');
    expect(outcome.reason).toContain('private regular file');
    expect(outcome.connector.gitPath).toBe('');
  });

  /** An ancestor directory of the provisioning directory that is a symbolic link refuses, and the reason names that ancestor. */
  it('LoadVerifierProvisioning_SymlinkedAncestor_IsUnusable', async ({ skip }) => {
    if (process.platform !== 'linux') return skip();
    const root = privateRoot();
    const real = join(root, 'real');
    mkdirSync(real, { mode: 0o700 });
    const { directory, tokenPath } = provisioningDirectory(real);
    clientFile(directory, clientBody(directory, tokenPath));
    const alias = join(root, 'alias');
    symlinkSync(real, alias);

    const outcome = await loadVerifierProvisioning(join(alias, 'verifier', 'client.json'));

    expect(outcome.kind).toBe('unusable');
    if (outcome.kind !== 'unusable') throw new Error('expected an unusable provisioning');
    expect(outcome.reason).toContain(`${alias} is a symbolic link`);
  });

  /** The strict schema refuses an unknown field and names it, so a typo never reads as a usable provisioning. */
  it('LoadVerifierProvisioning_StrictSchema_RefusesAnUnknownField', async ({ skip }) => {
    if (process.platform !== 'linux') return skip();
    const root = privateRoot();
    const { directory, tokenPath } = provisioningDirectory(root);
    const path = clientFile(directory, clientBody(directory, tokenPath, { resourceID: 'typo' }));

    const outcome = await loadVerifierProvisioning(path);

    expect(outcome.kind).toBe('unusable');
    if (outcome.kind !== 'unusable') throw new Error('expected an unusable provisioning');
    expect(outcome.reason).toContain('strict schema');
    expect(outcome.reason).toContain('resourceID');
  });

  /** A usable read passes the exact bytes of the top-level resource and profile identities, with no trim and no normalization. */
  it('LoadVerifierProvisioning_Usable_KeepsTheExactIdentityBytes', async ({ skip }) => {
    if (process.platform !== 'linux') return skip();
    const root = privateRoot();
    const { directory, tokenPath } = provisioningDirectory(root);
    const resourceId = ' resourceé one ';
    const profileId = 'profile/é two\t';
    const path = clientFile(directory, clientBody(directory, tokenPath, { resourceId, profileId }));

    const outcome = await loadVerifierProvisioning(path);

    expect(outcome.kind).toBe('usable');
    if (outcome.kind !== 'usable') throw new Error('expected a usable provisioning');
    expect(outcome.connector.resourceId).toBe(' resource\u00e9 one ');
    expect(outcome.connector.profileId).toBe('profile/\u0065\u0301 two\t');
    expect(outcome.connector.profileId.normalize('NFC')).not.toBe(outcome.connector.profileId);
    expect(outcome.connector.gitPath).toBe('/usr/bin/git');
  });
});
