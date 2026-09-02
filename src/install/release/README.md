# Release — reproducible, source-linked, signed artifacts (P05-01)

This module produces and verifies the **signed release manifest**: the single
artifact an installer consumes to answer *"is this the release I think it is,
produced by a publisher I trust, from the source and contract I expect, and did
the bytes I downloaded survive?"*

It **consumes** existing infrastructure rather than duplicating it:

| Concern | Reused from | Used here for |
| --- | --- | --- |
| Contract identity | **P03-01** `contract/authority-digest.ts` (`digestParts`) + `authority-pin.ts` (`AUTHORITY_IDS`, `AuthorityLock`) | Roll-up digest of the frozen authority lock — an aggregation of digests P03-01 already pinned, **not** a rival hash. |
| Install identity | **P05-04** `install/install-identity.ts` (`digestTree`, `buildInstallIdentity`, `InstallIdentitySchema`) | The `install` record embedded in the manifest is exactly what P05-04's freshness gate consumes — one identity format, not two. |
| Signing | **P03-08** `extensions/trust-root.ts` (`signDetached`, `TrustRootSet.verify`, `SIGNATURE_ALGORITHM`) + `canonical.ts` (`canonicalBytes`) | Ed25519 over deterministic canonical JSON. No hand-rolled crypto. |

## Files

| File | Role |
| --- | --- |
| `build-identity.ts` | Pure derivation of `SourceIdentity` (git commit + tree digest) and `ContractIdentity` (P03-01 lock roll-up). No fs / git / clock. |
| `release-manifest.ts` | The manifest wire contract + `buildReleaseManifest` / `signReleaseManifest` / `serializeSignedManifest` / `parseSignedManifest`, and the **raw-byte** asset digester `digestAssetBytes`. |
| `installer-verify.ts` | `verifyReleaseInstall` — the fail-closed 4-way installer gate. |
| `release-verify-cli.ts` | Thin argv CLI (`runReleaseVerify`) the installer scripts delegate to. |

## Manifest format (v1)

`SignedReleaseManifest` — serialized as **canonical (key-sorted) JSON** so two
independent builds from identical source produce byte-identical text:

```jsonc
{
  "manifest": {
    "manifestVersion": 1,
    "version": "2.12.0",                    // root package.json version
    "source": {
      "commit": "<40-hex git SHA>",         // exact provenance; abbreviated/uncommitted rejected
      "treeDigest": "sha256:<hex>"          // digestTree(): order-independent, line-ending/path-sep normalized
    },
    "contract": {
      "digest": "sha256:<hex>",             // digestParts() roll-up of the P03-01 authority lock
      "approvedBy": "<lock.approvedBy>",     // provenance of the underlying lock (not trust)
      "authorityCount": 6                    // guards silent authority truncation
    },
    "install": { /* P05-04 InstallIdentity — consumed verbatim by freshness-check */ },
    "assets": [
      {
        "name": "exarchos-linux-x64",       // release filename an installer downloads
        "os": "linux",                       // linux | darwin | windows
        "arch": "x64",                       // x64 | arm64
        "size": 98000000,                    // exact byte length
        "digest": "sha256:<hex>"             // RAW bytes — NOT normalized (see below)
      }
      // ... one per published asset
    ]
  },
  "signature": {
    "keyId": "publisher.a",
    "algorithm": "ed25519",
    "value": "<base64 detached signature over canonicalBytes(manifest)>"
  }
}
```

### What gets signed

`manifestSigningBytes(manifest) = canonicalBytes(manifestToCanonical(manifest))`
— the canonical JSON of the **manifest body only** (the `signature` object is
excluded). Both signer and verifier derive these bytes from the *parsed*
manifest, so transport whitespace/formatting is irrelevant. Ed25519 is
deterministic, so identical bytes yield an identical signature.

### Why asset digests are RAW bytes (and identity digests are normalized)

P03-01 / P05-04 digest **text** with line-ending normalization (CRLF/CR→LF,
trailing-newline strip) so a tree authored on Windows and verified on Linux
agrees. A native binary is **not text** — normalizing CRLF-like byte pairs
*inside* it would corrupt the digest and diverge from what an installer computes
with `sha512sum` / `Get-FileHash`. So `digestAssetBytes` hashes the exact bytes
with no normalization. This deliberate asymmetry is pinned by a test.

## Installer verification — four independently fail-closed dimensions

`verifyReleaseInstall` rejects, in this fixed priority order:

1. **`manifest-signature`** — the manifest does not chain to a configured trust
   root (tampered body / wrong / unknown key / malformed signature). Checked
   **first**: nothing in a manifest is trustworthy until its signature is.
2. **`source-mismatch`** — a validly-signed manifest describes a different
   `source` (commit / tree digest) than the installer pins. *A valid signature
   over the wrong source is still rejected: signature ≠ provenance.*
3. **`contract-mismatch`** — built against a different frozen contract authority
   (P03-01) than expected.
4. **`asset-digest`** — a downloaded file is absent from, or does not match, the
   signed manifest. An empty presented set is itself a rejection (nothing was
   verified).

Each dimension is independently seedable (a manifest with exactly one fault is
rejected for exactly that reason). No throw escapes as a pass.

### CLI seam (`release-verify-cli.ts`)

`tools/release/get-exarchos.ps1` / `.sh` delegate to this CLI. Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Verified — signed by `<keyId>`. |
| `2` | Rejected — prints `release REJECTED [<reason>]: <detail>`. |
| `3` | Usage error (missing/malformed argument). |

Args: `--manifest <path>` `--trust-root <keyId>=<pubkey.pem>` (repeatable)
`--expect-source <commit>#<treeDigest>` `--expect-contract <sha256:...>`
`--asset <name>=<file>` (repeatable).

## Reproducibility — verified vs. asserted

- **Verified (byte-identical across two independent builds):**
  - The JS bundle from `bun build` (non-`--compile`).
  - The manifest / identity layer: `buildReleaseManifest`, `manifestSigningBytes`,
    and the Ed25519 signature are deterministic — `serializeSignedManifest` of two
    independent builds from identical source is byte-identical (pinned by a test).
- **Known non-reproducible (upstream, could NOT fix here):** the native binary
  from `bun build --compile` differs by exactly **2 bytes** (an embedded Bun
  build-nonce, at offset `0xD0` and near EOF) between otherwise-identical builds.
  This is a Bun limitation, not our source/config. Downstream publishing
  (P05-02/03/05) should either digest the reproducible JS bundle, pin a Bun
  version whose nonce is controllable, or record the binary digest post-build
  from a canonical builder rather than asserting cross-builder byte-equality.

## Downstream (P05-02 / P05-03 / P05-05)

This module provides the **primitives and format**; it does not itself publish
or wire verification into the live installer download flow (the manifest is not
published yet, and the network path is untestable here). To build on it:

1. A build-time collector shells out to git (`rev-parse HEAD`, tree listing),
   reads the P03-01 lock, builds each asset, and calls `buildSourceIdentity` /
   `contractIdentityFromLock` / `buildInstallIdentity` / `releaseAssetFromBytes`
   → `buildReleaseManifest` → `signReleaseManifest`.
2. The release workflow publishes `serializeSignedManifest(...)` alongside the
   assets.
3. The installer downloads the manifest + asset, then calls the CLI (already
   wired as tested helpers in `get-exarchos.ps1` / `.sh`) to fail closed on any
   of the four mismatches before installing.
