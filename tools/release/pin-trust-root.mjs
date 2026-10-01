#!/usr/bin/env node
// @ts-check
/**
 * Pin the publisher trust root in both standalone installers, or check that it is pinned.
 *
 *   node tools/release/pin-trust-root.mjs <public-key.pem> [installer ...]
 *   node tools/release/pin-trust-root.mjs --check [installer ...]
 *
 * Pin mode accepts only an Ed25519 public key in SPKI PEM form. It replaces the
 * sentinel in each installer with that PEM and changes no other byte. It writes
 * nothing unless every installer holds the sentinel exactly once.
 * Check mode fails while an installer still holds the sentinel, or when the
 * installers do not pin the same Ed25519 key. The release workflow runs it.
 * The default installers are get-exarchos.sh and get-exarchos.ps1 beside this file.
 */

import { createHash, createPublicKey } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The placeholder both installers hold until the publisher key is pinned. */
export const SENTINEL = '__EXARCHOS_PUBLISHER_TRUST_ROOT_PEM_UNPINNED__';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_INSTALLERS = [join(HERE, 'get-exarchos.sh'), join(HERE, 'get-exarchos.ps1')];

/** The assignment that holds the trust root, per installer kind. */
const ASSIGNMENTS = {
  sh: /^PINNED_TRUST_ROOT_PEM="([^"]*)"\r?$/gm,
  ps1: /^\$script:PinnedTrustRootPem = '([^']*)'\r?$/gm,
};

class Refusal extends Error {}

/** @param {string} path */
function kindOf(path) {
  if (path.endsWith('.sh')) return 'sh';
  if (path.endsWith('.ps1')) return 'ps1';
  throw new Refusal(`${path}: not a .sh or .ps1 installer`);
}

/**
 * Parse an Ed25519 SPKI public key PEM and return its canonical text and fingerprint.
 * @param {string} text
 * @param {string} origin
 */
export function parseEd25519PublicPem(text, origin) {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (normalized.includes('PRIVATE KEY')) {
    throw new Refusal(`${origin} holds a PRIVATE key. Pin only the public half, and never share or commit the private key.`);
  }
  if (!/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+\n-----END PUBLIC KEY-----$/.test(normalized)) {
    throw new Refusal(`${origin} is not an SPKI public key PEM (-----BEGIN PUBLIC KEY-----)`);
  }
  let key;
  try {
    key = createPublicKey(normalized);
  } catch {
    throw new Refusal(`${origin} does not hold a readable public key`);
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Refusal(`${origin} holds a ${String(key.asymmetricKeyType)} key; the release manifest is signed with Ed25519`);
  }
  const pem = key.export({ type: 'spki', format: 'pem' }).toString().trim();
  const fingerprint = createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
  return { pem, fingerprint };
}

/**
 * Return the pinned key of one installer, or refuse when it is unpinned or unreadable.
 * @param {string} path
 * @param {string} text
 */
export function pinnedKeyOf(path, text) {
  const values = [...text.matchAll(ASSIGNMENTS[kindOf(path)])].map((match) => match[1] ?? '');
  if (values.length !== 1) {
    throw new Refusal(`${path}: expected one trust-root assignment, found ${values.length}`);
  }
  const [value] = values;
  if (value === SENTINEL || text.includes(SENTINEL)) {
    throw new Refusal(`${path}: the publisher trust root is not pinned (it still holds ${SENTINEL})`);
  }
  return parseEd25519PublicPem(value ?? '', `${path}: the pinned trust root`);
}

/**
 * Refuse unless every installer pins the same Ed25519 key. Returns its fingerprint.
 * @param {readonly string[]} installers
 */
export function checkPinned(installers) {
  const keys = installers.map((path) => pinnedKeyOf(path, readFileSync(path, 'utf8')));
  const fingerprints = new Set(keys.map((key) => key.fingerprint));
  if (fingerprints.size !== 1) {
    throw new Refusal(`the installers pin different keys: ${[...fingerprints].join(', ')}`);
  }
  return keys[0]?.fingerprint ?? '';
}

/**
 * Replace the sentinel with the key in every installer. Writes nothing on refusal.
 * @param {string} pemPath
 * @param {readonly string[]} installers
 */
export function pin(pemPath, installers) {
  const { pem, fingerprint } = parseEd25519PublicPem(readFileSync(pemPath, 'utf8'), pemPath);
  const updates = installers.map((path) => {
    const before = readFileSync(path, 'utf8');
    const occurrences = before.split(SENTINEL).length - 1;
    if (occurrences !== 1) {
      throw new Refusal(`${path}: expected the sentinel exactly once, found it ${occurrences} times`);
    }
    const after = before.replace(SENTINEL, () => pem);
    if (pinnedKeyOf(path, after).fingerprint !== fingerprint) {
      throw new Refusal(`${path}: the pinned key does not read back as the key that was given`);
    }
    return { path, after };
  });
  for (const { path, after } of updates) writeFileSync(path, after, 'utf8');
  return fingerprint;
}

/** @param {readonly string[]} argv */
function main(argv) {
  const [first, ...rest] = argv;
  if (first === undefined || (first.startsWith('-') && first !== '--check')) {
    process.stderr.write('usage: pin-trust-root.mjs <public-key.pem> [installer ...] | --check [installer ...]\n');
    return 2;
  }
  const installers = rest.length > 0 ? rest : DEFAULT_INSTALLERS;
  try {
    if (first === '--check') {
      const fingerprint = checkPinned(installers);
      process.stdout.write(`trust root pinned in ${installers.map((p) => basename(p)).join(' and ')} (SPKI SHA-256 ${fingerprint})\n`);
    } else {
      const fingerprint = pin(first, installers);
      process.stdout.write(`pinned the Ed25519 trust root (SPKI SHA-256 ${fingerprint}) in ${installers.join(', ')}\n`);
    }
    return 0;
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    process.stderr.write(`refused: ${err.message}\n`);
    return 1;
  }
}

/** True when this file is the process entry point, not an import. */
function invokedDirectly() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = main(process.argv.slice(2));
}
