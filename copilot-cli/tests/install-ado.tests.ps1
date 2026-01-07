#Requires -Modules Pester
<#
.SYNOPSIS
    Tests for Azure DevOps MCP installation functionality
.DESCRIPTION
    Pester tests for Install-AdoMcp function and MCP configuration management
#>

BeforeAll {
    $ScriptPath = Join-Path $PSScriptRoot ".." "scripts" "install-copilot-workflow.ps1"

    # Source the script to get access to functions (suppress main execution)
    # We need to dot-source with parameters that skip execution
    $script:OriginalErrorAction = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"

    # Create a mock environment to prevent actual installation
    $env:COPILOT_TEST_MODE = "1"

    # Import functions by parsing the script
    . $ScriptPath -SourceRepo "." -SkipValidation 2>$null

    $ErrorActionPreference = $script:OriginalErrorAction
}

AfterAll {
    Remove-Item Env:\COPILOT_TEST_MODE -ErrorAction SilentlyContinue
}

Describe "Install-AdoMcp" {
    It "Should define Install-AdoMcp function" {
        Get-Command Install-AdoMcp -ErrorAction SilentlyContinue | Should -Not -BeNullOrEmpty
    }

    It "Should have ConfigPath parameter" {
        $cmd = Get-Command Install-AdoMcp -ErrorAction SilentlyContinue
        $cmd.Parameters.Keys | Should -Contain "ConfigPath"
    }

    It "Should have Force parameter" {
        $cmd = Get-Command Install-AdoMcp -ErrorAction SilentlyContinue
        $cmd.Parameters.Keys | Should -Contain "Force"
    }

    It "Should support ShouldProcess (WhatIf)" {
        $cmd = Get-Command Install-AdoMcp -ErrorAction SilentlyContinue
        $cmd.Parameters.Keys | Should -Contain "WhatIf"
    }
}

Describe "MCP Config Creation" {
    BeforeEach {
        $script:TestConfigDir = Join-Path $TestDrive "test-copilot-$(Get-Random)"
        New-Item -ItemType Directory -Path $script:TestConfigDir -Force | Out-Null
        $script:TestConfigPath = Join-Path $script:TestConfigDir ".mcp.json"
    }

    AfterEach {
        if (Test-Path $script:TestConfigDir) {
            Remove-Item -Path $script:TestConfigDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It "Should create MCP config if not exists" {
        Install-AdoMcp -ConfigPath $script:TestConfigPath -WhatIf:$false

        Test-Path $script:TestConfigPath | Should -Be $true
    }

    It "Should create valid JSON config" {
        Install-AdoMcp -ConfigPath $script:TestConfigPath -WhatIf:$false

        $config = Get-Content $script:TestConfigPath -Raw | ConvertFrom-Json
        $config | Should -Not -BeNullOrEmpty
        $config.mcpServers | Should -Not -BeNullOrEmpty
    }

    It "Should configure azure-devops server" {
        Install-AdoMcp -ConfigPath $script:TestConfigPath -WhatIf:$false

        $config = Get-Content $script:TestConfigPath -Raw | ConvertFrom-Json
        $config.mcpServers.'azure-devops' | Should -Not -BeNullOrEmpty
    }

    It "Should set correct command for azure-devops" {
        Install-AdoMcp -ConfigPath $script:TestConfigPath -WhatIf:$false

        $config = Get-Content $script:TestConfigPath -Raw | ConvertFrom-Json
        $config.mcpServers.'azure-devops'.command | Should -Be "npx"
    }

    It "Should set correct args for azure-devops" {
        Install-AdoMcp -ConfigPath $script:TestConfigPath -WhatIf:$false

        $config = Get-Content $script:TestConfigPath -Raw | ConvertFrom-Json
        $config.mcpServers.'azure-devops'.args | Should -Contain "@anthropic/azure-devops-mcp"
    }

    It "Should configure environment variables" {
        Install-AdoMcp -ConfigPath $script:TestConfigPath -WhatIf:$false

        $config = Get-Content $script:TestConfigPath -Raw | ConvertFrom-Json
        $config.mcpServers.'azure-devops'.env.AZURE_DEVOPS_ORG_URL | Should -Not -BeNullOrEmpty
        $config.mcpServers.'azure-devops'.env.AZURE_DEVOPS_PAT | Should -Not -BeNullOrEmpty
    }

    It "Should preserve existing servers when adding azure-devops" {
        # Create existing config with another server
        $existingConfig = @{
            mcpServers = @{
                "other-server" = @{
                    command = "node"
                    args = @("other.js")
                }
            }
        }
        $existingConfig | ConvertTo-Json -Depth 5 | Set-Content $script:TestConfigPath -Encoding UTF8

        Install-AdoMcp -ConfigPath $script:TestConfigPath -WhatIf:$false

        $newConfig = Get-Content $script:TestConfigPath -Raw | ConvertFrom-Json
        $newConfig.mcpServers.'other-server' | Should -Not -BeNullOrEmpty
        $newConfig.mcpServers.'other-server'.command | Should -Be "node"
        $newConfig.mcpServers.'azure-devops' | Should -Not -BeNullOrEmpty
    }

    It "Should update existing azure-devops config when Force is used" {
        # Create existing config with old azure-devops config
        $existingConfig = @{
            mcpServers = @{
                "azure-devops" = @{
                    command = "old-command"
                    args = @("old-args")
                }
            }
        }
        $existingConfig | ConvertTo-Json -Depth 5 | Set-Content $script:TestConfigPath -Encoding UTF8

        Install-AdoMcp -ConfigPath $script:TestConfigPath -Force -WhatIf:$false

        $newConfig = Get-Content $script:TestConfigPath -Raw | ConvertFrom-Json
        $newConfig.mcpServers.'azure-devops'.command | Should -Be "npx"
    }

    It "Should create config directory if it does not exist" {
        $nestedPath = Join-Path $TestDrive "nested" "dir" ".mcp.json"

        Install-AdoMcp -ConfigPath $nestedPath -WhatIf:$false

        Test-Path $nestedPath | Should -Be $true
    }
}

Describe "Idempotency" {
    BeforeEach {
        $script:TestConfigDir = Join-Path $TestDrive "test-copilot-$(Get-Random)"
        New-Item -ItemType Directory -Path $script:TestConfigDir -Force | Out-Null
        $script:TestConfigPath = Join-Path $script:TestConfigDir ".mcp.json"
    }

    AfterEach {
        if (Test-Path $script:TestConfigDir) {
            Remove-Item -Path $script:TestConfigDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It "Should be safe to run multiple times" {
        # Run twice - should not error
        Install-AdoMcp -ConfigPath $script:TestConfigPath -WhatIf:$false
        { Install-AdoMcp -ConfigPath $script:TestConfigPath -WhatIf:$false } | Should -Not -Throw

        # Config should still be valid
        $config = Get-Content $script:TestConfigPath -Raw | ConvertFrom-Json
        $config.mcpServers.'azure-devops' | Should -Not -BeNullOrEmpty
    }

    It "Should not duplicate azure-devops entry on repeated runs" {
        Install-AdoMcp -ConfigPath $script:TestConfigPath -WhatIf:$false
        Install-AdoMcp -ConfigPath $script:TestConfigPath -WhatIf:$false
        Install-AdoMcp -ConfigPath $script:TestConfigPath -WhatIf:$false

        $config = Get-Content $script:TestConfigPath -Raw | ConvertFrom-Json
        # Count should be 1 - no duplicates
        ($config.mcpServers.PSObject.Properties | Where-Object Name -eq 'azure-devops').Count | Should -Be 1
    }
}
