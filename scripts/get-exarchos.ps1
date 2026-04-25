<#
.SYNOPSIS
Bootstrap installer for the exarchos CLI on Windows.

.DESCRIPTION
Downloads the `exarchos` binary from GitHub Releases, verifies its
SHA-512 checksum, installs it to the user's install directory, and
appends that directory to the user's Path environment variable.

Mirrors scripts/get-exarchos.sh (task 2.5). Both scripts share a
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

    [switch]$Help
)

# ---------------------------------------------------------------------------
# Library: small, pure helpers.
#
# Every non-trivial piece of behavior lives in a named function so the
# Pester suite (scripts/get-exarchos.ps1.test.ps1) can unit-test it
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

    $arch = switch ($ProcessorArchitecture.ToUpperInvariant()) {
        'AMD64' { 'x64' }
        'X64'   { 'x64' }
        'ARM64' { 'arm64' }
        default {
            throw "Unsupported Windows architecture: '$ProcessorArchitecture'. Supported: AMD64 (x64), ARM64."
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
    $env:GITHUB_PATH. Mirrors the `echo "$dir" >> "$GITHUB_PATH"` pattern
    used by GitHub Actions setup scripts.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$GithubPathFile,
        [Parameter(Mandatory)][string]$InstallDir
    )

    Add-Content -Path $GithubPathFile -Value $InstallDir
}

function Get-DownloadUrl {
    <#
    .SYNOPSIS
    Resolve the asset download URL for a given version/tier/asset-name.
    Version empty → /latest/download; non-empty → /download/<version>.

    `staging` and `dev` are stubs in v2.9 — they emit a warning and fall
    back to the `release` URL. This mirrors `scripts/get-exarchos.sh`
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

    $base = 'https://github.com/lvlup-sw/exarchos/releases'

    if ([string]::IsNullOrEmpty($Version)) {
        return "$base/latest/download/$AssetName"
    }

    return "$base/download/$Version/$AssetName"
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
        [Parameter(Mandatory)][string]$InstallDir,
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

        Write-Host "[exarchos] Downloading $AssetName..."
        Invoke-Download -Url $BinaryUrl -OutFile $tmpBinary
        Invoke-Download -Url $ChecksumUrl -OutFile $tmpSha

        Write-Host "[exarchos] Verifying SHA-512 checksum..."
        if (-not (Test-ChecksumMatches -BinaryPath $tmpBinary -Sha512Path $tmpSha)) {
            throw "Checksum mismatch for $AssetName. Refusing to install."
        }

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

    $binaryUrl = Get-DownloadUrl -Version $Version -Tier $Tier -AssetName $target.AssetName
    $checksumUrl = "$binaryUrl.sha512"

    if ($DryRun) {
        Write-Plan `
            -AssetName $target.AssetName `
            -BinaryUrl $binaryUrl `
            -ChecksumUrl $checksumUrl `
            -InstallDir $resolvedInstallDir `
            -Tier $Tier `
            -Version $Version `
            -GithubActionsMode:$GithubActions.IsPresent
        exit 0
    }

    Install-Binary `
        -AssetName $target.AssetName `
        -BinaryUrl $binaryUrl `
        -ChecksumUrl $checksumUrl `
        -InstallDir $resolvedInstallDir `
        -GithubActionsMode:$GithubActions

    exit 0
}
catch {
    Write-Error "[exarchos] Install failed: $($_.Exception.Message)"
    exit 1
}
