// ─── Installer-side release verification CLI (P05-01) ──────────────────────
//
// The seam the bootstrap installers (`scripts/get-exarchos.ps1` / `.sh`)
// delegate to for the ONE verification dimension shells cannot do natively —
// Ed25519 signature checking — plus, for defense in depth, the other three
// (source, contract, asset digest). It wraps the pure `verifyReleaseInstall`
// core with argv parsing + file IO, and maps its fail-closed verdict onto a
// process exit code:
//
//   exit 0  — the release is authentic, from the expected source + contract,
//             and every presented asset matches the signed manifest.
//   exit 2  — a verification failure (reason printed to stderr). NON-ZERO so a
//             caller `|| exit 1` refuses to install.
//   exit 3  — a usage error (missing/garbled arguments).
//
// The IO is injected (`ReleaseVerifyIo`) so `runReleaseVerify` is unit-testable
// without touching the real filesystem or process.
//
// Usage (from an installer, after downloading the asset + manifest):
//   node release-verify-cli.js \
//     --manifest <signed-manifest.json> \
//     --trust-root <keyId>=<publicKey.pem> [--trust-root …] \
//     --expect-source <commit>#<sha256:treeDigest> \
//     --expect-contract <sha256:contractDigest> \
//     --asset <name>=<downloaded-file> [--asset …]

import { TrustRootSet, type TrustRootConfig, SIGNATURE_ALGORITHM } from '../../runtime/extensions/trust-root.js';
import { SourceIdentitySchema, type SourceIdentity, type ContractIdentity } from './build-identity.js';
import { digestAssetBytes, parseSignedManifest } from './release-manifest.js';
import { verifyReleaseInstall, type ObservedAsset } from './installer-verify.js';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Filesystem seam so the CLI core is testable without real IO. */
export interface ReleaseVerifyIo {
  readText(path: string): string;
  readBytes(path: string): Uint8Array;
}

/** Result of a CLI run: a process exit code + a human-facing message. */
export interface ReleaseVerifyOutcome {
  readonly exitCode: 0 | 2 | 3;
  readonly message: string;
}

class UsageError extends Error {}

interface ParsedArgs {
  readonly manifestPath: string;
  readonly trustRoots: readonly TrustRootConfig[];
  readonly expectedSource: SourceIdentity;
  readonly expectedContractDigest: string;
  readonly assets: ReadonlyMap<string, string>;
}

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined) throw new UsageError(`missing value for ${flag}`);
  return value;
}

/** Split `key=value` once, tolerating `=` inside the value. */
function splitOnce(text: string, flag: string): { key: string; value: string } {
  const idx = text.indexOf('=');
  if (idx <= 0) throw new UsageError(`expected <key>=<value> for ${flag}, got '${text}'`);
  return { key: text.slice(0, idx), value: text.slice(idx + 1) };
}

function parseArgs(argv: readonly string[], io: ReleaseVerifyIo): ParsedArgs {
  let manifestPath: string | undefined;
  const trustRoots: TrustRootConfig[] = [];
  let sourceSpec: string | undefined;
  let expectedContractDigest: string | undefined;
  const assets = new Map<string, string>();

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--manifest':
        manifestPath = requireValue(flag, argv[++i]);
        break;
      case '--trust-root': {
        const { key, value } = splitOnce(requireValue(flag, argv[++i]), flag);
        trustRoots.push({
          keyId: key,
          algorithm: SIGNATURE_ALGORITHM,
          publicKeyPem: io.readText(value),
        });
        break;
      }
      case '--expect-source':
        sourceSpec = requireValue(flag, argv[++i]);
        break;
      case '--expect-contract':
        expectedContractDigest = requireValue(flag, argv[++i]);
        break;
      case '--asset': {
        const { key, value } = splitOnce(requireValue(flag, argv[++i]), flag);
        assets.set(key, value);
        break;
      }
      default:
        throw new UsageError(`unknown argument '${String(flag)}'`);
    }
  }

  if (manifestPath === undefined) throw new UsageError('--manifest is required');
  if (trustRoots.length === 0) throw new UsageError('at least one --trust-root is required');
  if (sourceSpec === undefined) throw new UsageError('--expect-source is required');
  if (expectedContractDigest === undefined) throw new UsageError('--expect-contract is required');

  const hashIdx = sourceSpec.indexOf('#');
  if (hashIdx <= 0) {
    throw new UsageError(`--expect-source must be <commit>#<treeDigest>, got '${sourceSpec}'`);
  }
  const expectedSource = SourceIdentitySchema.parse({
    commit: sourceSpec.slice(0, hashIdx),
    treeDigest: sourceSpec.slice(hashIdx + 1),
  });

  return { manifestPath, trustRoots, expectedSource, expectedContractDigest, assets };
}

/**
 * Run the release-verification CLI over `argv` (flags only, no argv0/argv1).
 * Pure aside from the injected {@link ReleaseVerifyIo}. Never throws — every
 * failure shape maps to a non-zero exit code, so a verification error can never
 * be mistaken for a pass.
 */
export function runReleaseVerify(argv: readonly string[], io: ReleaseVerifyIo): ReleaseVerifyOutcome {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv, io);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { exitCode: 3, message: `usage error: ${message}` };
  }

  try {
    const signed = parseSignedManifest(io.readText(args.manifestPath));
    const trustRoots = new TrustRootSet(args.trustRoots);
    const observedAssets = new Map<string, ObservedAsset>();
    for (const [name, path] of args.assets) {
      observedAssets.set(name, { digest: digestAssetBytes(io.readBytes(path)) });
    }
    const expectedContract: ContractIdentity = {
      digest: args.expectedContractDigest,
      approvedBy: '(pinned by installer)',
      authorityCount: 1,
    };

    const result = verifyReleaseInstall({
      signed,
      trustRoots,
      expectedSource: args.expectedSource,
      expectedContract,
      observedAssets,
    });

    if (result.ok) {
      return { exitCode: 0, message: `release verified — signed by ${result.keyId}` };
    }
    return { exitCode: 2, message: `release REJECTED [${result.reason}]: ${result.detail}` };
  } catch (err) {
    // Malformed manifest, unreadable file, bad public key — all fail closed.
    const message = err instanceof Error ? err.message : String(err);
    return { exitCode: 2, message: `release REJECTED [verification-error]: ${message}` };
  }
}

/** Real-filesystem IO for the direct-invocation entrypoint. */
export function nodeReleaseVerifyIo(): ReleaseVerifyIo {
  return {
    readText: (path: string): string => fs.readFileSync(path, 'utf8'),
    readBytes: (path: string): Uint8Array => fs.readFileSync(path),
  };
}

// Executed only when run directly (never on import), so importing this module
// for `runReleaseVerify` in a test has no side effect.
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const outcome = runReleaseVerify(process.argv.slice(2), nodeReleaseVerifyIo());
  const stream = outcome.exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`${outcome.message}\n`);
  process.exit(outcome.exitCode);
}
