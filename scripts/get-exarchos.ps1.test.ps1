<#
.SYNOPSIS
Pester tests for scripts/get-exarchos.ps1 — Windows bootstrap installer.

.DESCRIPTION
Mirrors the test coverage of scripts/get-exarchos.sh (task 2.5). The tests
exercise the installer's surface area without ever performing a real HTTP
download: the script is sourced in "library mode" (-LoadOnly) so its
internal functions can be unit-tested directly.

Runs under Pester v5+. If Pester is not available on the host, a parallel
vitest wrapper at scripts/get-exarchos.ps1.test.ts spawns `pwsh` to cover
the end-to-end dry-run path.

Run locally:
  Invoke-Pester -Path scripts/get-exarchos.ps1.test.ps1 -Output Detailed
#>

BeforeAll {
    $script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    $script:ScriptPath = Join-Path $PSScriptRoot 'get-exarchos.ps1'

    if (-not (Test-Path $script:ScriptPath)) {
        throw "get-exarchos.ps1 not found at $script:ScriptPath — this test suite REDs until the script is created."
    }

    # Dot-source with -LoadOnly so internal functions are available for
    # direct invocation without running the installer's main entry point.
    . $script:ScriptPath -LoadOnly
}

Describe 'get-exarchos.ps1' {

    Context 'GetExarchos_DryRun_PrintsInstallPlan' {
        It 'prints a plan and exits 0 without mutating the filesystem' {
            $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("exarchos-dryrun-" + [Guid]::NewGuid())
            try {
                $env:EXARCHOS_INSTALL_DIR = $tmpDir
                $stdout = & $script:ScriptPath -DryRun 2>&1 | Out-String
                $LASTEXITCODE | Should -Be 0
                $stdout | Should -Match '(?i)(dry.?run|plan|would install)'
                $stdout | Should -Match 'exarchos-windows-(x64|arm64)'
                $stdout | Should -Match '\.sha512'
                # Dry-run MUST NOT create the install directory
                (Test-Path $tmpDir) | Should -BeFalse
            }
            finally {
                Remove-Item Env:\EXARCHOS_INSTALL_DIR -ErrorAction SilentlyContinue
                if (Test-Path $tmpDir) { Remove-Item -Recurse -Force $tmpDir }
            }
        }
    }

    Context 'GetExarchos_PlatformDetection_Windows_x64' {
        It 'selects exarchos-windows-x64.exe for AMD64' {
            $target = Get-PlatformTarget -ProcessorArchitecture 'AMD64'
            $target.Os | Should -Be 'windows'
            $target.Arch | Should -Be 'x64'
            $target.AssetName | Should -Be 'exarchos-windows-x64.exe'
        }
    }

    Context 'GetExarchos_PlatformDetection_Windows_arm64' {
        It 'selects exarchos-windows-arm64.exe for ARM64' {
            $target = Get-PlatformTarget -ProcessorArchitecture 'ARM64'
            $target.Os | Should -Be 'windows'
            $target.Arch | Should -Be 'arm64'
            $target.AssetName | Should -Be 'exarchos-windows-arm64.exe'
        }

        It 'throws on unsupported architectures' {
            { Get-PlatformTarget -ProcessorArchitecture 'MIPS64' } | Should -Throw '*Unsupported*'
        }
    }

    Context 'GetExarchos_HostArchitecture_Fallback' {
        It 'prefers $env:PROCESSOR_ARCHITECTURE when set' {
            $saved = $env:PROCESSOR_ARCHITECTURE
            try {
                $env:PROCESSOR_ARCHITECTURE = 'ARM64'
                (Get-HostArchitecture) | Should -Be 'ARM64'
            }
            finally {
                $env:PROCESSOR_ARCHITECTURE = $saved
            }
        }
    }

    Context 'GetExarchos_ChecksumMismatch_RefusesInstall' {
        It 'fails fast when the sha512 sidecar does not match the binary' {
            $tmp = New-Item -ItemType Directory -Path (Join-Path ([System.IO.Path]::GetTempPath()) ("exarchos-chk-" + [Guid]::NewGuid()))
            try {
                $binary = Join-Path $tmp.FullName 'exarchos.exe'
                Set-Content -Path $binary -Value 'pretend binary contents' -NoNewline
                # Deliberately wrong checksum
                $sidecar = Join-Path $tmp.FullName 'exarchos.exe.sha512'
                Set-Content -Path $sidecar -Value ('0' * 128 + "  exarchos.exe") -NoNewline

                $ok = Test-ChecksumMatches -BinaryPath $binary -Sha512Path $sidecar
                $ok | Should -BeFalse
            }
            finally {
                Remove-Item -Recurse -Force $tmp.FullName
            }
        }

        It 'accepts a matching sha512 sidecar' {
            $tmp = New-Item -ItemType Directory -Path (Join-Path ([System.IO.Path]::GetTempPath()) ("exarchos-chk-ok-" + [Guid]::NewGuid()))
            try {
                $binary = Join-Path $tmp.FullName 'exarchos.exe'
                Set-Content -Path $binary -Value 'pretend binary contents' -NoNewline
                $actual = (Get-FileHash -Path $binary -Algorithm SHA512).Hash.ToLower()
                $sidecar = Join-Path $tmp.FullName 'exarchos.exe.sha512'
                # GNU coreutils-compatible "HASH  FILENAME" layout
                Set-Content -Path $sidecar -Value "$actual  exarchos.exe" -NoNewline

                $ok = Test-ChecksumMatches -BinaryPath $binary -Sha512Path $sidecar
                $ok | Should -BeTrue
            }
            finally {
                Remove-Item -Recurse -Force $tmp.FullName
            }
        }
    }

    Context 'GetExarchos_RegistryPathAppend' {
        It 'appends install dir to user Path and is idempotent' {
            $existingPath = 'C:\existing\one;C:\existing\two'
            $installDir = 'C:\Users\test\.exarchos\bin'

            # First call: install dir not present → appended
            $result1 = Add-ToUserPath -CurrentPath $existingPath -InstallDir $installDir
            $result1.Changed | Should -BeTrue
            $result1.NewPath | Should -Match ([Regex]::Escape($installDir))
            ($result1.NewPath -split ';').Count | Should -Be 3

            # Second call: idempotent — no duplicate
            $result2 = Add-ToUserPath -CurrentPath $result1.NewPath -InstallDir $installDir
            $result2.Changed | Should -BeFalse
            $result2.NewPath | Should -Be $result1.NewPath
            ($result2.NewPath -split ';' | Where-Object { $_ -eq $installDir }).Count | Should -Be 1
        }

        It 'handles empty current Path' {
            $installDir = 'C:\Users\test\.exarchos\bin'
            $result = Add-ToUserPath -CurrentPath '' -InstallDir $installDir
            $result.Changed | Should -BeTrue
            $result.NewPath | Should -Be $installDir
        }
    }

    Context 'GetExarchos_VersionFlag_PinsRelease' {
        It 'produces a URL pinned to the exact tag when -Version is supplied' {
            $url = Get-DownloadUrl -Version 'v2.9.0-rc1' -Tier 'release' -AssetName 'exarchos-windows-x64.exe'
            $url | Should -Be 'https://github.com/lvlup-sw/exarchos/releases/download/v2.9.0-rc1/exarchos-windows-x64.exe'
        }

        It 'uses /latest/download when no version is specified' {
            $url = Get-DownloadUrl -Version '' -Tier 'release' -AssetName 'exarchos-windows-x64.exe'
            $url | Should -Be 'https://github.com/lvlup-sw/exarchos/releases/latest/download/exarchos-windows-x64.exe'
        }
    }

    Context 'GetExarchos_GithubActionsMode_WritesGithubPath' {
        It 'appends install dir to the $GITHUB_PATH file when -GithubActions is set' {
            $tmp = New-Item -ItemType Directory -Path (Join-Path ([System.IO.Path]::GetTempPath()) ("exarchos-ghpath-" + [Guid]::NewGuid()))
            $ghPathFile = Join-Path $tmp.FullName 'github_path'
            New-Item -ItemType File -Path $ghPathFile | Out-Null
            try {
                Write-GithubPath -GithubPathFile $ghPathFile -InstallDir 'C:\install\dir'
                $contents = Get-Content $ghPathFile -Raw
                $contents | Should -Match 'C:\\install\\dir'
            }
            finally {
                Remove-Item -Recurse -Force $tmp.FullName
            }
        }
    }
}
