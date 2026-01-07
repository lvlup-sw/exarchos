#Requires -Modules Pester
<#
.SYNOPSIS
    Pester tests for Azure DevOps authentication helpers
.DESCRIPTION
    Tests Get-AdoToken and Test-AdoConnection functions
#>

BeforeAll {
    . (Join-Path $PSScriptRoot ".." "scripts" "ado-auth.ps1")
}

Describe "Get-AdoToken" {
    Context "When AZURE_DEVOPS_PAT is set" {
        BeforeAll {
            $env:AZURE_DEVOPS_PAT = "test-pat-token"
        }

        AfterAll {
            Remove-Item Env:\AZURE_DEVOPS_PAT -ErrorAction SilentlyContinue
        }

        It "Should return the PAT token" {
            $result = Get-AdoToken
            $result | Should -Be "test-pat-token"
        }
    }

    Context "When no token source available" {
        BeforeAll {
            $script:OriginalPat = $env:AZURE_DEVOPS_PAT
            Remove-Item Env:\AZURE_DEVOPS_PAT -ErrorAction SilentlyContinue
        }

        AfterAll {
            if ($script:OriginalPat) {
                $env:AZURE_DEVOPS_PAT = $script:OriginalPat
            }
        }

        It "Should throw an error when az CLI is not available" {
            # Mock az command to fail
            Mock az { throw "az not available" }
            { Get-AdoToken } | Should -Throw
        }
    }

    Context "When Azure CLI fallback succeeds" {
        BeforeAll {
            $script:OriginalPat = $env:AZURE_DEVOPS_PAT
            Remove-Item Env:\AZURE_DEVOPS_PAT -ErrorAction SilentlyContinue
        }

        AfterAll {
            if ($script:OriginalPat) {
                $env:AZURE_DEVOPS_PAT = $script:OriginalPat
            }
        }

        It "Should return token from Azure CLI when PAT not set" {
            Mock az { "cli-token-value" }
            Mock Set-Variable {}
            $global:LASTEXITCODE = 0
            $result = Get-AdoToken
            $result | Should -Be "cli-token-value"
        }
    }
}

Describe "Test-AdoConnection" {
    It "Should accept Organization parameter" {
        $cmd = Get-Command Test-AdoConnection -ErrorAction SilentlyContinue
        $cmd | Should -Not -BeNullOrEmpty
        $cmd.Parameters.Keys | Should -Contain "Organization"
    }

    It "Should have Organization as mandatory parameter" {
        $cmd = Get-Command Test-AdoConnection -ErrorAction SilentlyContinue
        $param = $cmd.Parameters["Organization"]
        $param.Attributes | Where-Object { $_ -is [System.Management.Automation.ParameterAttribute] } |
            ForEach-Object { $_.Mandatory } | Should -Be $true
    }

    Context "When connection succeeds" {
        It "Should return true" {
            Mock Get-AdoToken { "mock-token" }
            Mock az { "project-name" }
            $global:LASTEXITCODE = 0
            $result = Test-AdoConnection -Organization "test-org"
            $result | Should -Be $true
        }
    }

    Context "When connection fails" {
        It "Should return false" {
            Mock Get-AdoToken { throw "No token available" }
            $result = Test-AdoConnection -Organization "invalid-org"
            $result | Should -Be $false
        }
    }
}
