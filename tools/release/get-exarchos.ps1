<#
.SYNOPSIS
Bootstrap installer for the exarchos CLI on Windows.

.DESCRIPTION
Downloads the `exarchos` binary from GitHub Releases, verifies its
SHA-512 checksum, installs it to the user's install directory, and
appends that directory to the user's Path environment variable.

Mirrors tools/release/get-exarchos.sh (task 2.5). Both scripts share a
contract: same URL layout, same asset naming, same quality tiers.

.PARAMETER Tier
Quality tier to install from: `release` (default, tagged GitHub
Releases), `staging` (pre-release), or `dev` (HEAD artifact).

.PARAMETER Version
Pin a specific version (e.g. `v2.9.0-rc1`). When empty, the latest
release for the selected tier is used.

.PARAMETER InstallDir
Destination directory for the binary. Defaults to
`$env:EXARCHOS_INSTALL_DIR` if set, otherwise
`$env:USERPROFILE\.exarchos\bin`.

.PARAMETER DryRun
Print the install plan (platform, URLs, destination) and exit 0
without touching the filesystem or network.

.PARAMETER GithubActions
Append `$InstallDir` to the file referenced by `$env:GITHUB_PATH`
instead of the user-scope registry `Path`. Used inside
`actions/github-script`-style runners.

.PARAMETER LoadOnly
Sentinel flag for the Pester test suite. When set, the script
dot-sources its helper functions into the caller scope and returns
without executing the main install body. Not intended for end users.

.PARAMETER AllowModifiedSource
Accept an artifact whose embedded build identity reports
`sourceState=modified` — i.e. it was compiled from a working tree that
did not match the commit it names. REFUSED by default: that is exactly
the case where the signed manifest's source digest cannot vouch for the
compiled bytes.

.PARAMETER Help
Print usage and exit 0.

.EXAMPLE
iwr -useb https://get.exarchos.dev/get-exarchos.ps1 | iex

.EXAMPLE
powershell -File get-exarchos.ps1 -Version v2.9.0 -DryRun
#>

[CmdletBinding()]
param(
    [ValidateSet('release', 'staging', 'dev')]
    [string]$Tier = 'release',

    [string]$Version = '',

    [string]$InstallDir = '',

    [switch]$DryRun,

    [switch]$GithubActions,

    [switch]$LoadOnly,

    [switch]$AllowModifiedSource,

    [switch]$Help
)

# ---------------------------------------------------------------------------
# Release verification constants (DR-20)
# ---------------------------------------------------------------------------

# The signed release manifest published alongside the binaries. Exported as
# RELEASE_MANIFEST_FILENAME from tools/release/build-release-manifest.ts — a WIRE
# CONTRACT with the publishing workflow.
$script:ReleaseManifestFilename = 'exarchos-release-manifest.json'

# Build-identity banner marker stamped into every artifact by
# tools/release/build-binary.ts. v2 carries `sourceState`; a v1 artifact predates it
# and is therefore UNTRUSTWORTHY rather than "assumed clean" — an omitted field
# must never be able to downgrade a check.
$script:BuildIdentityMarker = 'exarchos-build-identity/v2'

# ---------------------------------------------------------------------------
# PINNED PUBLISHER TRUST ROOT
# ---------------------------------------------------------------------------
# The Ed25519 PUBLIC key the release manifest's signature must chain to.
#
# It is pinned HERE, in the installer, and deliberately NOT published as a
# release asset: shipping a verifying key next to the signature it verifies is
# trust-on-first-use and buys nothing — whoever can replace the signature can
# replace the key. Pinning is what makes the `manifest-signature` dimension
# mean anything at all.
#
# Until the publisher key is pinned below, this installer FAILS CLOSED: it
# refuses to install rather than silently skipping signature verification.
# Replacing the sentinel is a release-engineering step (pin the SPKI PEM of the
# public half of `EXARCHOS_RELEASE_SIGNING_KEY`).
$script:PinnedTrustRootKeyId = 'exarchos.release.v1'
$script:PinnedTrustRootPem = '__EXARCHOS_PUBLISHER_TRUST_ROOT_PEM_UNPINNED__'

# ---------------------------------------------------------------------------
# Library: small, pure helpers.
#
# Every non-trivial piece of behavior lives in a named function so the
# Pester suite (tools/release/get-exarchos.ps1.test.ps1) can unit-test it
# directly via the -LoadOnly entry point. The `Main` block below only
# sequences these helpers; it contains no logic of its own.
# ---------------------------------------------------------------------------

function Get-PlatformTarget {
    <#
    .SYNOPSIS
    Map the PROCESSOR_ARCHITECTURE env var to an exarchos asset triple.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$ProcessorArchitecture
    )

    # Bun has no `bun-windows-arm64` cross-compile target, so
    # `tools/release/build-binary.ts` only ships `windows-x64`. Mapping ARM64
    # to `exarchos-windows-arm64.exe` here would 404 at download. Refuse
    # ARM64 explicitly until Bun lands the target (tracked in the v2.9
    # release blockers).
    $arch = switch ($ProcessorArchitecture.ToUpperInvariant()) {
        'AMD64' { 'x64' }
        'X64'   { 'x64' }
        'ARM64' {
            throw "Windows ARM64 is not yet supported. Bun does not provide a bun-windows-arm64 cross-compile target as of v2.9. Track https://github.com/lvlup-sw/exarchos/issues for native ARM64 support, or run under x64 emulation."
        }
        default {
            throw "Unsupported Windows architecture: '$ProcessorArchitecture'. Supported: AMD64 (x64)."
        }
    }

    [pscustomobject]@{
        Os        = 'windows'
        Arch      = $arch
        AssetName = "exarchos-windows-$arch.exe"
    }
}

function Test-ChecksumMatches {
    <#
    .SYNOPSIS
    Verify a downloaded binary matches the hash recorded in its sha512
    sidecar file. Returns $true iff the hashes match (case-insensitive).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$BinaryPath,
        [Parameter(Mandatory)][string]$Sha512Path
    )

    if (-not (Test-Path $BinaryPath)) { return $false }
    if (-not (Test-Path $Sha512Path)) { return $false }

    $actual = (Get-FileHash -Path $BinaryPath -Algorithm SHA512).Hash.ToLowerInvariant()

    # Sidecar format mirrors GNU coreutils: "<hash>  <filename>".
    # Accept either that format or a bare hash on a single line.
    $raw = (Get-Content -Path $Sha512Path -Raw).Trim()
    $expected = ($raw -split '\s+')[0].ToLowerInvariant()

    return ($actual -eq $expected)
}

function Get-AssetSha256 {
    <#
    .SYNOPSIS
    Raw-byte SHA-256 of a file as `sha256:<lowerhex>` — the exact digest form
    the signed release manifest records (see release-manifest.ts
    `digestAssetBytes`). Unlike the text digests used for the contract / install
    identity, this is over raw bytes (a binary is not line-ending-normalizable).
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)
    $hash = (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    return "sha256:$hash"
}

function Get-SignedManifest {
    <#
    .SYNOPSIS
    Parse a signed release manifest JSON file into an object. Throws on
    malformed JSON so a caller can fail closed.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)
    return (Get-Content -Path $Path -Raw | ConvertFrom-Json)
}

function Test-ManifestAssetDigest {
    <#
    .SYNOPSIS
    ASSET-DIGEST dimension: return $true iff the downloaded file's raw SHA-256
    matches the digest the signed manifest records for $AssetName. Fails closed
    ($false) if the manifest does not enumerate the asset at all.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Manifest,
        [Parameter(Mandatory)][string]$AssetName,
        [Parameter(Mandatory)][string]$Path
    )
    if (-not (Test-Path $Path)) { return $false }
    $asset = @($Manifest.manifest.assets | Where-Object { $_.name -eq $AssetName }) | Select-Object -First 1
    if ($null -eq $asset) { return $false }
    return ((Get-AssetSha256 -Path $Path) -eq $asset.digest)
}

function Test-ManifestSourceIdentity {
    <#
    .SYNOPSIS
    SOURCE dimension: return $true iff the manifest's embedded source identity
    (commit + tree digest) matches the values the installer pins.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Manifest,
        [Parameter(Mandatory)][string]$ExpectedCommit,
        [Parameter(Mandatory)][string]$ExpectedTreeDigest
    )
    return (($Manifest.manifest.source.commit -eq $ExpectedCommit) -and
            ($Manifest.manifest.source.treeDigest -eq $ExpectedTreeDigest))
}

function Test-ManifestContractIdentity {
    <#
    .SYNOPSIS
    CONTRACT dimension: return $true iff the manifest's embedded contract
    authority digest (P03-01 roll-up) matches the value the installer pins.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Manifest,
        [Parameter(Mandatory)][string]$ExpectedContractDigest
    )
    return ($Manifest.manifest.contract.digest -eq $ExpectedContractDigest)
}

function Test-ManifestSignature {
    <#
    .SYNOPSIS
    MANIFEST-SIGNATURE dimension: delegate Ed25519 signature verification to the
    shipped verifier (`dist/release-verify.js` / the `exarchos-release-verify`
    bin, i.e. the tested `runReleaseVerify` core) via `node`. Windows PowerShell
    (.NET Framework) has no Ed25519 primitive, so this is the one dimension the
    shell cannot do natively.

    The verifier checks all four dimensions in one fail-closed pass; its verdict
    line (`release REJECTED [<reason>]: …`) is echoed so the operator sees WHICH
    dimension failed.

    Fails CLOSED: returns $false when no runner or verifier is available — an
    unverifiable signature is treated exactly like a bad one.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$VerifierPath,
        [Parameter(Mandatory)][string]$ManifestPath,
        [Parameter(Mandatory)][string]$TrustRootKeyId,
        [Parameter(Mandatory)][string]$TrustRootPubKeyPath,
        [Parameter(Mandatory)][string]$ExpectedSource,
        [Parameter(Mandatory)][string]$ExpectedContractDigest,
        [Parameter(Mandatory)][string]$AssetName,
        [Parameter(Mandatory)][string]$AssetPath
    )
    if (-not (Test-Path $VerifierPath)) { return $false }

    $verifierArgs = @(
        '--manifest', $ManifestPath,
        '--trust-root', "$TrustRootKeyId=$TrustRootPubKeyPath",
        '--expect-source', $ExpectedSource,
        '--expect-contract', $ExpectedContractDigest,
        '--asset', "$AssetName=$AssetPath"
    )

    if ($VerifierPath -like '*.js') {
        $node = Get-Command node -ErrorAction SilentlyContinue
        if ($null -eq $node) { return $false }
        $output = & node $VerifierPath @verifierArgs 2>&1
    } else {
        $output = & $VerifierPath @verifierArgs 2>&1
    }
    $code = $LASTEXITCODE
    foreach ($line in @($output)) { Write-Host "[exarchos] $line" }
    return ($code -eq 0)
}

function Get-EmbeddedBuildIdentity {
    <#
    .SYNOPSIS
    Recover the build identity that `tools/release/build-binary.ts` stamped into an
    artifact's RAW BYTES, or $null when the artifact carries none.

    Streams the file in chunks (a released binary is ~100MB) decoding latin1 —
    a lossless byte<->char mapping, so binary regions cannot corrupt the scan.
    The search prefix INCLUDES the v2 marker, so a v1 (or forged older-format)
    banner does not match and the caller rejects rather than treating a missing
    `sourceState` as "clean".
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path $Path)) { return $null }

    $prefix = 'globalThis.__EXARCHOS_BUILD_IDENTITY__={"marker":"' + $script:BuildIdentityMarker + '"'
    $latin1 = [System.Text.Encoding]::GetEncoding(28591)
    $chunk = 1048576
    $window = $null
    $carry = ''

    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $buffer = New-Object byte[] $chunk
        while (($read = $stream.Read($buffer, 0, $chunk)) -gt 0) {
            $text = $carry + $latin1.GetString($buffer, 0, $read)
            $idx = $text.IndexOf($prefix, [System.StringComparison]::Ordinal)
            if ($idx -ge 0) {
                if (($text.Length - $idx) -ge 16384) {
                    $window = $text.Substring($idx, 16384)
                    break
                }
                # Match found near the end of the buffer — keep it and grow.
                $carry = $text.Substring($idx)
            } elseif ($text.Length -gt 65536) {
                $carry = $text.Substring($text.Length - 65536)
            } else {
                $carry = $text
            }
        }
    } finally {
        $stream.Dispose()
    }

    if ($null -eq $window) {
        $idx = $carry.IndexOf($prefix, [System.StringComparison]::Ordinal)
        if ($idx -lt 0) { return $null }
        $window = $carry.Substring($idx)
    }

    $commit = [regex]::Match($window, '"commit":"([^"]*)"')
    $tree = [regex]::Match($window, '"treeDigest":"([^"]*)"')
    $state = [regex]::Match($window, '"sourceState":"([^"]*)"')
    $ver = [regex]::Match($window, '"version":"([^"]*)"')
    # Anchored on `"contract":{"digest":` so it cannot be satisfied by the
    # unrelated `treeDigest` field.
    $contract = [regex]::Match($window, '"contract":\{"digest":"([^"]*)"')

    foreach ($m in @($commit, $tree, $state, $ver, $contract)) {
        if (-not $m.Success) { return $null }
    }

    return [pscustomobject]@{
        Commit         = $commit.Groups[1].Value
        TreeDigest     = $tree.Groups[1].Value
        SourceState    = $state.Groups[1].Value
        Version        = $ver.Groups[1].Value
        ContractDigest = $contract.Groups[1].Value
    }
}

function Resolve-ReleaseVerifier {
    <#
    .SYNOPSIS
    Locate the shipped release verifier, or return $null.

    Discovery order: explicit override, the package's own `dist/` (repo checkout
    or an npm-installed @lvlup-sw/exarchos), then the `exarchos-release-verify`
    bin that package.json exposes. It is NEVER downloaded from the release being
    verified — fetching your verifier from the origin you are verifying is not
    verification.
    #>
    [CmdletBinding()]
    param([string]$ScriptRoot = '')

    if (-not [string]::IsNullOrEmpty($env:EXARCHOS_RELEASE_VERIFIER)) {
        if (Test-Path $env:EXARCHOS_RELEASE_VERIFIER) { return $env:EXARCHOS_RELEASE_VERIFIER }
        return $null
    }
    if (-not [string]::IsNullOrEmpty($ScriptRoot)) {
        $candidate = Join-Path $ScriptRoot '../../dist/release-verify.js'
        if (Test-Path $candidate) { return (Resolve-Path $candidate).Path }
    }
    $bin = Get-Command exarchos-release-verify -ErrorAction SilentlyContinue
    if ($null -ne $bin) { return $bin.Source }
    return $null
}

function Resolve-TrustRootPem {
    <#
    .SYNOPSIS
    Materialize the publisher PUBLIC key the manifest signature must chain to,
    returning a file path — or $null when none is available.

    $null is FATAL to the caller: an unpinned installer refuses to install
    rather than skipping signature verification.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$WorkDir)

    if (-not [string]::IsNullOrEmpty($env:EXARCHOS_TRUST_ROOT_PEM_FILE)) {
        if (Test-Path $env:EXARCHOS_TRUST_ROOT_PEM_FILE) { return $env:EXARCHOS_TRUST_ROOT_PEM_FILE }
        return $null
    }
    if ($script:PinnedTrustRootPem -notlike '*BEGIN PUBLIC KEY*') { return $null }

    $pemPath = Join-Path $WorkDir 'pinned-trust-root.pem'
    Set-Content -Path $pemPath -Value $script:PinnedTrustRootPem -Encoding ascii
    return $pemPath
}

function Invoke-ReleaseManifestVerification {
    <#
    .SYNOPSIS
    The complete fail-closed release gate. Throws on the FIRST failing check, so
    nothing is ever written to the install location for a release that did not
    verify. Every check below is independently fatal:

      1. build identity present  — a v2 `exarchos-build-identity` banner in the
                                   downloaded bytes. Absent (or v1) is fatal.
      2-5. signature, source,    — one delegated, fail-closed pass through the
         contract, asset digest    shipped verifier. `--expect-source` /
                                   `--expect-contract` come from the ARTIFACT's
                                   own embedded identity, making this a
                                   cross-check between two independent objects
                                   (signed manifest vs. downloaded bytes), not a
                                   self-comparison.
      6. release binding         — a validly-signed OLDER release is still the
                                   wrong one.
      7. source state            — checked LAST, and only once the asset-digest
                                   check has authenticated the bytes.

    Steps 3/4/5 are additionally re-checked natively (Test-Manifest*) as
    defense in depth, so a tampered source/contract/asset is caught even if the
    delegated pass were ever weakened.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$VerifierPath,
        [Parameter(Mandatory)][string]$ManifestPath,
        [Parameter(Mandatory)][string]$TrustRootKeyId,
        [Parameter(Mandatory)][string]$TrustRootPubKeyPath,
        [Parameter(Mandatory)][string]$AssetName,
        [Parameter(Mandatory)][string]$AssetPath,
        [Parameter(Mandatory)][AllowEmptyString()][string]$ExpectedTag,
        [switch]$AllowModifiedSource
    )

    if (-not (Test-Path $ManifestPath)) {
        throw "Release REJECTED [manifest-missing]: no signed $($script:ReleaseManifestFilename) was published for $ExpectedTag. Refusing to install an unverifiable release."
    }

    $identity = Get-EmbeddedBuildIdentity -Path $AssetPath
    if ($null -eq $identity) {
        throw "Release REJECTED [build-identity]: $AssetName carries no '$($script:BuildIdentityMarker)' build identity — its source and contract provenance cannot be established. Refusing to install."
    }

    $manifest = Get-SignedManifest -Path $ManifestPath

    if (-not (Test-ManifestSignature -VerifierPath $VerifierPath -ManifestPath $ManifestPath `
            -TrustRootKeyId $TrustRootKeyId -TrustRootPubKeyPath $TrustRootPubKeyPath `
            -ExpectedSource "$($identity.Commit)#$($identity.TreeDigest)" `
            -ExpectedContractDigest $identity.ContractDigest `
            -AssetName $AssetName -AssetPath $AssetPath)) {
        throw "Release REJECTED: the signed release manifest did not verify (signature / source / contract / asset digest). Refusing to install."
    }
    if (-not (Test-ManifestSourceIdentity -Manifest $manifest -ExpectedCommit $identity.Commit -ExpectedTreeDigest $identity.TreeDigest)) {
        throw "Release REJECTED [source-mismatch]: the signed manifest describes a different source than the downloaded artifact. Refusing to install."
    }
    if (-not (Test-ManifestContractIdentity -Manifest $manifest -ExpectedContractDigest $identity.ContractDigest)) {
        throw "Release REJECTED [contract-mismatch]: the signed manifest describes a different contract authority than the downloaded artifact. Refusing to install."
    }
    if (-not (Test-ManifestAssetDigest -Manifest $manifest -AssetName $AssetName -Path $AssetPath)) {
        throw "Release REJECTED [asset-digest]: $AssetName does not match the digest in the signed manifest. Refusing to install."
    }

    $expectedVersion = $ExpectedTag -replace '^v', ''
    if (-not [string]::IsNullOrEmpty($expectedVersion) -and $identity.Version -ne $expectedVersion) {
        throw "Release REJECTED [release-binding]: $AssetName declares version '$($identity.Version)' but release '$ExpectedTag' was requested. Refusing to install."
    }

    if ($identity.SourceState -ne 'clean') {
        if (-not $AllowModifiedSource) {
            throw "Release REJECTED [source-state]: $AssetName was built from a MODIFIED working tree (sourceState=$($identity.SourceState)); the manifest's source digest cannot vouch for these bytes. Re-run with -AllowModifiedSource to accept it anyway."
        }
        Write-Warning "[exarchos] artifact reports sourceState=$($identity.SourceState) — accepted only because -AllowModifiedSource was given"
    }

    Write-Host "[exarchos] Release manifest verified — signature, source, contract, asset digest, release binding and source state all match."
}

function Add-ToUserPath {
    <#
    .SYNOPSIS
    Pure function returning the new user-Path string after (idempotently)
    appending $InstallDir. Caller is responsible for persisting via
    [Environment]::SetEnvironmentVariable.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]$CurrentPath,
        [Parameter(Mandatory)][string]$InstallDir
    )

    $entries = if ([string]::IsNullOrEmpty($CurrentPath)) {
        @()
    } else {
        $CurrentPath -split ';' | Where-Object { $_ -ne '' }
    }

    # Case-insensitive compare, matching Windows Path semantics.
    $already = $false
    foreach ($e in $entries) {
        if ($e.Trim().Equals($InstallDir, [System.StringComparison]::OrdinalIgnoreCase)) {
            $already = $true
            break
        }
    }

    if ($already) {
        return [pscustomobject]@{
            Changed = $false
            NewPath = $CurrentPath
        }
    }

    $newPath = if ([string]::IsNullOrEmpty($CurrentPath)) {
        $InstallDir
    } else {
        "$CurrentPath;$InstallDir"
    }

    [pscustomobject]@{
        Changed = $true
        NewPath = $newPath
    }
}

function Write-GithubPath {
    <#
    .SYNOPSIS
    Append $InstallDir as a new line to the file referenced by
    $env:GITHUB_PATH if it isn't already present. Mirrors the
    `echo "$dir" >> "$GITHUB_PATH"` pattern from GitHub Actions setup
    scripts but stays idempotent — re-running this script (e.g. after a
    cache miss or matrix retry) must not duplicate the directory in
    PATH.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$GithubPathFile,
        [Parameter(Mandatory)][string]$InstallDir
    )

    if (-not (Test-Path $GithubPathFile)) {
        # GitHub Actions creates the file; create it ourselves if missing
        # (e.g. local pwsh testing) so Get-Content below doesn't error.
        New-Item -ItemType File -Path $GithubPathFile -Force | Out-Null
    }

    $existing = Get-Content -Path $GithubPathFile -ErrorAction SilentlyContinue
    if ($null -ne $existing) {
        foreach ($line in $existing) {
            if ($line.Trim().Equals($InstallDir, [System.StringComparison]::OrdinalIgnoreCase)) {
                # Already present — leave the file untouched so repeated
                # runs don't grow PATH unbounded.
                return
            }
        }
    }

    Add-Content -Path $GithubPathFile -Value $InstallDir
}

function Get-DownloadUrl {
    <#
    .SYNOPSIS
    Resolve the asset download URL for a given version/tier/asset-name.
    Version empty → /latest/download; non-empty → /download/<version>.

    `staging` and `dev` are stubs in v2.9 — they emit a warning and fall
    back to the `release` URL. This mirrors `tools/release/get-exarchos.sh`
    (line ~92) so the public flag stays self-documenting rather than
    silently fetching the wrong binary.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]$Version,
        [Parameter(Mandatory)][string]$Tier,
        [Parameter(Mandatory)][string]$AssetName
    )

    if ($Tier -eq 'staging' -or $Tier -eq 'dev') {
        Write-Warning "[exarchos] -Tier $Tier is a stub in v2.9 — falling back to release tier"
    }

    # `$env:EXARCHOS_RELEASE_BASE_URL` retargets the whole release URL space
    # (internal mirrors; the DR-20 acceptance suite serves a real signed fixture
    # release over loopback). Defaults to GitHub Releases.
    $base = if ([string]::IsNullOrEmpty($env:EXARCHOS_RELEASE_BASE_URL)) {
        'https://github.com/lvlup-sw/exarchos/releases'
    } else {
        $env:EXARCHOS_RELEASE_BASE_URL
    }

    if ([string]::IsNullOrEmpty($Version)) {
        return "$base/latest/download/$AssetName"
    }

    return "$base/download/$Version/$AssetName"
}

function Resolve-LatestVersion {
    <#
    .SYNOPSIS
    Resolve the latest release tag. Mirrors `get-exarchos.sh`'s
    `resolve_latest_version`, including the hermetic
    `$env:EXARCHOS_LATEST_VERSION` override.

    The real install path NEEDS a concrete tag (not the `/latest/download`
    alias) so the release-binding check has something to bind to: an artifact
    whose embedded version disagrees with the tag being installed is a
    rollback, and `latest` cannot detect one.
    #>
    [CmdletBinding()]
    param()

    if (-not [string]::IsNullOrEmpty($env:EXARCHOS_LATEST_VERSION)) {
        return $env:EXARCHOS_LATEST_VERSION
    }
    $response = Invoke-RestMethod -Uri 'https://api.github.com/repos/lvlup-sw/exarchos/releases/latest' -UseBasicParsing -ErrorAction Stop
    if ([string]::IsNullOrEmpty($response.tag_name)) {
        throw 'Could not resolve the latest release tag from the GitHub API.'
    }
    return $response.tag_name
}

function Get-DefaultInstallDir {
    if ($env:EXARCHOS_INSTALL_DIR) {
        return $env:EXARCHOS_INSTALL_DIR
    }
    # USERPROFILE is the canonical Windows home variable, but Linux/macOS
    # PowerShell (`pwsh`) leaves it unset. Fall back to the cross-platform
    # $HOME automatic variable so dry-run smoke tests can exercise this
    # script on non-Windows CI runners without erroring on a null Path.
    $userHome = if (-not [string]::IsNullOrEmpty($env:USERPROFILE)) {
        $env:USERPROFILE
    } else {
        $HOME
    }
    return (Join-Path $userHome '.exarchos/bin')
}

function Get-HostArchitecture {
    <#
    .SYNOPSIS
    Return the value that should drive Get-PlatformTarget on this host.
    Prefers $env:PROCESSOR_ARCHITECTURE; falls back to
    [Environment]::Is64BitOperatingSystem on CI containers that don't
    surface the env var.
    #>
    if (-not [string]::IsNullOrEmpty($env:PROCESSOR_ARCHITECTURE)) {
        return $env:PROCESSOR_ARCHITECTURE
    }

    if ([Environment]::Is64BitOperatingSystem) {
        return 'AMD64'
    }

    return 'X86'
}

function Write-Plan {
    param(
        [string]$AssetName,
        [string]$BinaryUrl,
        [string]$ChecksumUrl,
        [string]$ManifestUrl,
        [string]$InstallDir,
        [string]$Tier,
        [string]$Version,
        [bool]$GithubActionsMode
    )

    Write-Host "[exarchos] Dry-run plan (no changes will be made):"
    Write-Host "  tier         : $Tier"
    Write-Host "  version      : $(if ([string]::IsNullOrEmpty($Version)) { '<latest>' } else { $Version })"
    Write-Host "  asset        : $AssetName"
    Write-Host "  binary url   : $BinaryUrl"
    Write-Host "  checksum url : $ChecksumUrl"
    Write-Host "  manifest url : $ManifestUrl"
    Write-Host "  install dir  : $InstallDir"
    if ($GithubActionsMode) {
        Write-Host "  PATH mode    : GITHUB_PATH ($env:GITHUB_PATH)"
    } else {
        Write-Host "  PATH mode    : user environment (persistent)"
    }
    Write-Host "Would install $AssetName to $InstallDir."
}

function Invoke-Download {
    param(
        [Parameter(Mandatory)][string]$Url,
        [Parameter(Mandatory)][string]$OutFile
    )

    $destDir = Split-Path -Parent $OutFile
    if (-not (Test-Path $destDir)) {
        New-Item -ItemType Directory -Path $destDir -Force | Out-Null
    }

    Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing -ErrorAction Stop
}

function Install-Binary {
    param(
        [Parameter(Mandatory)][string]$AssetName,
        [Parameter(Mandatory)][string]$BinaryUrl,
        [Parameter(Mandatory)][string]$ChecksumUrl,
        [Parameter(Mandatory)][string]$ManifestUrl,
        [Parameter(Mandatory)][AllowEmptyString()][string]$ExpectedTag,
        [Parameter(Mandatory)][string]$InstallDir,
        [string]$ScriptRoot = '',
        [switch]$AllowModifiedSource,
        [switch]$GithubActionsMode
    )

    if (-not (Test-Path $InstallDir)) {
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    }

    $tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("exarchos-install-" + [Guid]::NewGuid())
    New-Item -ItemType Directory -Path $tmpRoot -Force | Out-Null

    try {
        $tmpBinary = Join-Path $tmpRoot $AssetName
        $tmpSha = "$tmpBinary.sha512"
        $tmpManifest = Join-Path $tmpRoot $script:ReleaseManifestFilename

        Write-Host "[exarchos] Downloading $AssetName..."
        Invoke-Download -Url $BinaryUrl -OutFile $tmpBinary
        Invoke-Download -Url $ChecksumUrl -OutFile $tmpSha

        Write-Host "[exarchos] Verifying SHA-512 checksum..."
        if (-not (Test-ChecksumMatches -BinaryPath $tmpBinary -Sha512Path $tmpSha)) {
            throw "Checksum mismatch for $AssetName. Refusing to install."
        }

        # ── Signed release manifest verification (DR-20) — MANDATORY ────────
        # The sidecar above only proves the bytes survived transport: it is
        # served from the same origin as the binary, so anyone who can replace
        # one can replace the other. Everything that makes this release *this*
        # release is established below, before anything is installed.
        $verifier = Resolve-ReleaseVerifier -ScriptRoot $ScriptRoot
        if ($null -eq $verifier) {
            throw "Release REJECTED [verifier-unavailable]: could not locate the release verifier (dist/release-verify.js or the exarchos-release-verify bin). Set `$env:EXARCHOS_RELEASE_VERIFIER. Refusing to install (fail-closed)."
        }
        $trustRootPem = Resolve-TrustRootPem -WorkDir $tmpRoot
        if ($null -eq $trustRootPem) {
            throw "Release REJECTED [trust-root-unavailable]: no publisher trust root is pinned in this installer and `$env:EXARCHOS_TRUST_ROOT_PEM_FILE was not supplied. The manifest signature cannot be verified. Refusing to install."
        }
        $trustRootKeyId = if ([string]::IsNullOrEmpty($env:EXARCHOS_TRUST_ROOT_KEY_ID)) {
            $script:PinnedTrustRootKeyId
        } else {
            $env:EXARCHOS_TRUST_ROOT_KEY_ID
        }

        Write-Host "[exarchos] Verifying the signed release manifest..."
        try {
            Invoke-Download -Url $ManifestUrl -OutFile $tmpManifest
        } catch {
            throw "Release REJECTED [manifest-missing]: could not download $ManifestUrl ($($_.Exception.Message)). Releases without a signed manifest cannot be verified and are refused by design."
        }

        Invoke-ReleaseManifestVerification `
            -VerifierPath $verifier `
            -ManifestPath $tmpManifest `
            -TrustRootKeyId $trustRootKeyId `
            -TrustRootPubKeyPath $trustRootPem `
            -AssetName $AssetName `
            -AssetPath $tmpBinary `
            -ExpectedTag $ExpectedTag `
            -AllowModifiedSource:$AllowModifiedSource

        $finalName = 'exarchos.exe'
        $finalPath = Join-Path $InstallDir $finalName

        Move-Item -Path $tmpBinary -Destination $finalPath -Force
        Write-Host "[exarchos] Installed to $finalPath"

        if ($GithubActionsMode) {
            if ([string]::IsNullOrEmpty($env:GITHUB_PATH)) {
                throw '-GithubActions was specified but $env:GITHUB_PATH is not set.'
            }
            Write-GithubPath -GithubPathFile $env:GITHUB_PATH -InstallDir $InstallDir
            Write-Host "[exarchos] Appended $InstallDir to `$GITHUB_PATH."
        } else {
            $currentPath = [Environment]::GetEnvironmentVariable('Path', [EnvironmentVariableTarget]::User)
            if ($null -eq $currentPath) { $currentPath = '' }
            $result = Add-ToUserPath -CurrentPath $currentPath -InstallDir $InstallDir
            if ($result.Changed) {
                [Environment]::SetEnvironmentVariable('Path', $result.NewPath, [EnvironmentVariableTarget]::User)
                Write-Host "[exarchos] Added $InstallDir to user Path (open a new terminal to pick it up)."
            } else {
                Write-Host "[exarchos] $InstallDir already present in user Path."
            }
        }
    }
    finally {
        if (Test-Path $tmpRoot) {
            Remove-Item -Recurse -Force $tmpRoot -ErrorAction SilentlyContinue
        }
    }
}

# ---------------------------------------------------------------------------
# Main: sequences library helpers. No branching on anything outside the
# parameters and environment; errors bubble up to the outer try/catch.
# ---------------------------------------------------------------------------

if ($LoadOnly) {
    # Library-mode: helper functions are now defined in the caller's scope
    # (because Pester dot-sources this file). Do not execute the install.
    return
}

if ($Help) {
    Get-Help $PSCommandPath -Full
    exit 0
}

try {
    $target = Get-PlatformTarget -ProcessorArchitecture (Get-HostArchitecture)

    $resolvedInstallDir = if ([string]::IsNullOrEmpty($InstallDir)) {
        Get-DefaultInstallDir
    } else {
        $InstallDir
    }

    if ($DryRun) {
        # Keep -DryRun offline: no GitHub API round-trip, so air-gapped hosts
        # can still print the plan. The `latest/download` alias stands in.
        $binaryUrl = Get-DownloadUrl -Version $Version -Tier $Tier -AssetName $target.AssetName
        Write-Plan `
            -AssetName $target.AssetName `
            -BinaryUrl $binaryUrl `
            -ChecksumUrl "$binaryUrl.sha512" `
            -ManifestUrl (Get-DownloadUrl -Version $Version -Tier $Tier -AssetName $script:ReleaseManifestFilename) `
            -InstallDir $resolvedInstallDir `
            -Tier $Tier `
            -Version $Version `
            -GithubActionsMode:$GithubActions.IsPresent
        exit 0
    }

    # The real install path pins a CONCRETE tag so the release-binding check
    # has something to bind to (see Resolve-LatestVersion).
    $resolvedVersion = if ([string]::IsNullOrEmpty($Version)) { Resolve-LatestVersion } else { $Version }

    $binaryUrl = Get-DownloadUrl -Version $resolvedVersion -Tier $Tier -AssetName $target.AssetName
    $checksumUrl = "$binaryUrl.sha512"
    $manifestUrl = Get-DownloadUrl -Version $resolvedVersion -Tier $Tier -AssetName $script:ReleaseManifestFilename

    Install-Binary `
        -AssetName $target.AssetName `
        -BinaryUrl $binaryUrl `
        -ChecksumUrl $checksumUrl `
        -ManifestUrl $manifestUrl `
        -ExpectedTag $resolvedVersion `
        -InstallDir $resolvedInstallDir `
        -ScriptRoot $PSScriptRoot `
        -AllowModifiedSource:$AllowModifiedSource `
        -GithubActionsMode:$GithubActions

    Write-Host "[exarchos] Next: run 'exarchos onboard' to wire skills + config (or 'exarchos doctor' to check)."

    exit 0
}
catch {
    Write-Error "[exarchos] Install failed: $($_.Exception.Message)"
    exit 1
}
