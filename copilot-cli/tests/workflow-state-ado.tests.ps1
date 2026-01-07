#Requires -Version 5.1
#Requires -Modules Pester

<#
.SYNOPSIS
    Tests for Azure DevOps workflow state extensions
.DESCRIPTION
    Verifies init-ado command and ADO-specific state fields
#>

BeforeAll {
    $ScriptPath = Join-Path $PSScriptRoot ".." "scripts" "workflow-state.ps1"

    # Override StateDir for testing
    $script:TestStateDir = Join-Path $TestDrive "workflow-state"
    New-Item -ItemType Directory -Path $script:TestStateDir -Force | Out-Null
}

Describe "Workflow State ADO Extensions" {
    BeforeEach {
        # Clean up test state directory before each test
        Get-ChildItem -Path $script:TestStateDir -Filter "*.state.json" -ErrorAction SilentlyContinue | Remove-Item -Force
    }

    Context "init-ado command" {
        It "Should create state file with ADO fields" {
            # Arrange
            $env:WORKFLOW_STATE_DIR = $script:TestStateDir

            # Act
            & $ScriptPath init-ado "test-feature" -Organization "test-org" -Project "test-project" -RepositoryId "repo-guid-123"

            # Assert
            $stateFile = Join-Path $script:TestStateDir "test-feature.state.json"
            Test-Path $stateFile | Should -Be $true

            $state = Get-Content $stateFile -Raw | ConvertFrom-Json
            $state.ado | Should -Not -BeNullOrEmpty
        }

        It "Should set platform to azure-devops" {
            # Arrange
            $env:WORKFLOW_STATE_DIR = $script:TestStateDir

            # Act
            & $ScriptPath init-ado "platform-test" -Organization "test-org" -Project "test-project" -RepositoryId "repo-guid"

            # Assert
            $stateFile = Join-Path $script:TestStateDir "platform-test.state.json"
            $state = Get-Content $stateFile -Raw | ConvertFrom-Json
            $state.platform | Should -Be "azure-devops"
        }

        It "Should include organization, project, and repositoryId" {
            # Arrange
            $env:WORKFLOW_STATE_DIR = $script:TestStateDir

            # Act
            & $ScriptPath init-ado "ado-fields-test" -Organization "my-org" -Project "my-project" -RepositoryId "guid-12345"

            # Assert
            $stateFile = Join-Path $script:TestStateDir "ado-fields-test.state.json"
            $state = Get-Content $stateFile -Raw | ConvertFrom-Json
            $state.ado.organization | Should -Be "my-org"
            $state.ado.project | Should -Be "my-project"
            $state.ado.repositoryId | Should -Be "guid-12345"
        }

        It "Should use version 1.1" {
            # Arrange
            $env:WORKFLOW_STATE_DIR = $script:TestStateDir

            # Act
            & $ScriptPath init-ado "version-test" -Organization "test-org" -Project "test-project" -RepositoryId "repo-guid"

            # Assert
            $stateFile = Join-Path $script:TestStateDir "version-test.state.json"
            $state = Get-Content $stateFile -Raw | ConvertFrom-Json
            $state.version | Should -Be "1.1"
        }

        It "Should fail if state file already exists" {
            # Arrange
            $env:WORKFLOW_STATE_DIR = $script:TestStateDir
            $stateFile = Join-Path $script:TestStateDir "existing-feature.state.json"
            @{ existing = $true } | ConvertTo-Json | Set-Content -Path $stateFile -Encoding UTF8

            # Act & Assert
            { & $ScriptPath init-ado "existing-feature" -Organization "test-org" -Project "test-project" -RepositoryId "repo-guid" } |
                Should -Throw
        }

        It "Should require Organization parameter" {
            # Arrange
            $env:WORKFLOW_STATE_DIR = $script:TestStateDir

            # Act & Assert
            { & $ScriptPath init-ado "no-org-test" -Project "test-project" -RepositoryId "repo-guid" } |
                Should -Throw
        }

        It "Should require Project parameter" {
            # Arrange
            $env:WORKFLOW_STATE_DIR = $script:TestStateDir

            # Act & Assert
            { & $ScriptPath init-ado "no-project-test" -Organization "test-org" -RepositoryId "repo-guid" } |
                Should -Throw
        }

        It "Should require RepositoryId parameter" {
            # Arrange
            $env:WORKFLOW_STATE_DIR = $script:TestStateDir

            # Act & Assert
            { & $ScriptPath init-ado "no-repo-test" -Organization "test-org" -Project "test-project" } |
                Should -Throw
        }

        It "Should include all standard workflow fields" {
            # Arrange
            $env:WORKFLOW_STATE_DIR = $script:TestStateDir

            # Act
            & $ScriptPath init-ado "full-test" -Organization "test-org" -Project "test-project" -RepositoryId "repo-guid"

            # Assert
            $stateFile = Join-Path $script:TestStateDir "full-test.state.json"
            $state = Get-Content $stateFile -Raw | ConvertFrom-Json

            # Standard fields should exist
            $state.featureId | Should -Be "full-test"
            $state.phase | Should -Be "ideate"
            $state.createdAt | Should -Not -BeNullOrEmpty
            $state.updatedAt | Should -Not -BeNullOrEmpty
            $state.artifacts | Should -Not -BeNullOrEmpty
            $state.tasks | Should -Not -BeNullOrEmpty
            $state.synthesis | Should -Not -BeNullOrEmpty
        }
    }

    Context "Platform field on existing init command" {
        It "Should set platform to github for standard init" {
            # Arrange
            $env:WORKFLOW_STATE_DIR = $script:TestStateDir

            # Act
            & $ScriptPath init "github-feature"

            # Assert
            $stateFile = Join-Path $script:TestStateDir "github-feature.state.json"
            $state = Get-Content $stateFile -Raw | ConvertFrom-Json
            $state.platform | Should -Be "github"
        }
    }

    AfterAll {
        # Clean up environment variable
        Remove-Item Env:\WORKFLOW_STATE_DIR -ErrorAction SilentlyContinue
    }
}
