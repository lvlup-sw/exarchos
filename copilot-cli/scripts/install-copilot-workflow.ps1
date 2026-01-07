#Requires -Version 5.1
<#
.SYNOPSIS
    Install Copilot CLI workflow tools
.DESCRIPTION
    Sets up ~/.copilot directory with agents, scripts, and configuration.
    This script copies workflow management files to the user's home directory
    for use with GitHub Copilot CLI.
.PARAMETER SourceRepo
    Path to the lvlup-claude repository containing the source files.
    Defaults to the current directory.
.PARAMETER Force
    Overwrite existing files without prompting.
.PARAMETER SkipValidation
    Skip post-installation validation checks.
.EXAMPLE
    .\install-copilot-workflow.ps1
    Installs from current directory with validation.
.EXAMPLE
    .\install-copilot-workflow.ps1 -SourceRepo "C:\repos\lvlup-claude" -Force
    Installs from specified path, overwriting existing files.
.EXAMPLE
    .\install-copilot-workflow.ps1 -SkipValidation
    Installs without running validation tests.
.NOTES
    Requires jq for JSON manipulation. Install with: winget install jqlang.jq
    Requires npm for Azure DevOps MCP installation.
    Creates the following directory structure:
      ~/.copilot/
      ├── scripts/
      │   └── workflow-state.ps1
      ├── agents/
      │   ├── orchestrator.agent.md
      │   ├── implementer.agent.md
      │   ├── reviewer.agent.md
      │   └── integrator.agent.md
      ├── config.json
      └── .mcp.json (Azure DevOps MCP configuration)
#>

param(
    [string]$SourceRepo = ".",
    [switch]$Force,
    [switch]$SkipValidation
)

$ErrorActionPreference = "Stop"

# Define installation paths
$CopilotDir = Join-Path $env:USERPROFILE ".copilot"
$ScriptsDir = Join-Path $CopilotDir "scripts"
$AgentsDir = Join-Path $CopilotDir "agents"

function Write-Step {
    param([string]$Message)
    Write-Host "[*] $Message" -ForegroundColor Cyan
}

function Write-Success {
    param([string]$Message)
    Write-Host "[+] $Message" -ForegroundColor Green
}

function Write-Warning {
    param([string]$Message)
    Write-Host "[!] $Message" -ForegroundColor Yellow
}

function Write-Failure {
    param([string]$Message)
    Write-Host "[-] $Message" -ForegroundColor Red
}

function Test-Dependencies {
    <#
    .SYNOPSIS
        Verify required dependencies are installed
    #>
    Write-Step "Checking dependencies..."

    $Missing = @()

    # Check for jq
    if (-not (Get-Command jq -ErrorAction SilentlyContinue)) {
        $Missing += "jq (install with: winget install jqlang.jq)"
    }

    # Check for git
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        $Missing += "git (install with: winget install Git.Git)"
    }

    # Check for PowerShell version
    if ($PSVersionTable.PSVersion.Major -lt 5) {
        $Missing += "PowerShell 5.1+ (current: $($PSVersionTable.PSVersion))"
    }

    if ($Missing.Count -gt 0) {
        Write-Failure "Missing dependencies:"
        foreach ($Dep in $Missing) {
            Write-Host "    - $Dep" -ForegroundColor Red
        }
        throw "Please install missing dependencies and try again."
    }

    Write-Success "All dependencies found"
}

function Resolve-SourceRepo {
    <#
    .SYNOPSIS
        Resolve and validate source repository path
    #>
    $ResolvedPath = Resolve-Path $SourceRepo -ErrorAction SilentlyContinue

    if (-not $ResolvedPath) {
        throw "Source repository not found: $SourceRepo"
    }

    # Check for expected directory structure
    $ExpectedDirs = @(
        "copilot-cli/scripts",
        "copilot-cli/agents"
    )

    foreach ($Dir in $ExpectedDirs) {
        $FullPath = Join-Path $ResolvedPath $Dir
        if (-not (Test-Path $FullPath)) {
            throw "Invalid source repository: missing $Dir"
        }
    }

    return $ResolvedPath.Path
}

function Install-WorkflowFiles {
    <#
    .SYNOPSIS
        Install workflow files to ~/.copilot
    #>
    param([string]$Source)

    Write-Step "Installing workflow files..."

    # Create directory structure
    $Directories = @($CopilotDir, $ScriptsDir, $AgentsDir)

    foreach ($Dir in $Directories) {
        if (-not (Test-Path $Dir)) {
            New-Item -ItemType Directory -Path $Dir -Force | Out-Null
            Write-Success "Created directory: $Dir"
        } else {
            Write-Host "    Directory exists: $Dir" -ForegroundColor Gray
        }
    }

    # Define files to copy
    $FilesToCopy = @(
        @{
            Source = "copilot-cli/scripts/workflow-state.ps1"
            Dest = Join-Path $ScriptsDir "workflow-state.ps1"
            Description = "Workflow state management script"
        },
        @{
            Source = "copilot-cli/agents/orchestrator.agent.md"
            Dest = Join-Path $AgentsDir "orchestrator.agent.md"
            Description = "Orchestrator agent"
        },
        @{
            Source = "copilot-cli/agents/implementer.agent.md"
            Dest = Join-Path $AgentsDir "implementer.agent.md"
            Description = "Implementer agent"
        },
        @{
            Source = "copilot-cli/agents/reviewer.agent.md"
            Dest = Join-Path $AgentsDir "reviewer.agent.md"
            Description = "Reviewer agent"
        },
        @{
            Source = "copilot-cli/agents/integrator.agent.md"
            Dest = Join-Path $AgentsDir "integrator.agent.md"
            Description = "Integrator agent"
        }
    )

    foreach ($File in $FilesToCopy) {
        $SourcePath = Join-Path $Source $File.Source

        if (-not (Test-Path $SourcePath)) {
            Write-Warning "Source file not found: $SourcePath"
            continue
        }

        if ((Test-Path $File.Dest) -and -not $Force) {
            $Response = Read-Host "File exists: $($File.Dest). Overwrite? (y/N)"
            if ($Response -ne "y" -and $Response -ne "Y") {
                Write-Host "    Skipped: $($File.Description)" -ForegroundColor Gray
                continue
            }
        }

        Copy-Item -Path $SourcePath -Destination $File.Dest -Force
        Write-Success "Installed: $($File.Description)"
    }

    # Create config.json if it doesn't exist
    $ConfigFile = Join-Path $CopilotDir "config.json"
    if (-not (Test-Path $ConfigFile) -or $Force) {
        $Config = @{
            version = "1.0"
            installedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
            source = $Source
            paths = @{
                scripts = $ScriptsDir
                agents = $AgentsDir
            }
        }

        $Config | ConvertTo-Json -Depth 10 | Set-Content -Path $ConfigFile -Encoding UTF8
        Write-Success "Created: config.json"
    }
}

function Test-Installation {
    <#
    .SYNOPSIS
        Validate the installation by running basic tests
    #>
    Write-Step "Validating installation..."

    $Errors = @()

    # Check that all expected files exist
    $ExpectedFiles = @(
        (Join-Path $ScriptsDir "workflow-state.ps1"),
        (Join-Path $AgentsDir "orchestrator.agent.md"),
        (Join-Path $AgentsDir "implementer.agent.md"),
        (Join-Path $AgentsDir "reviewer.agent.md"),
        (Join-Path $AgentsDir "integrator.agent.md"),
        (Join-Path $CopilotDir "config.json")
    )

    foreach ($File in $ExpectedFiles) {
        if (Test-Path $File) {
            Write-Host "    [OK] $File" -ForegroundColor Green
        } else {
            Write-Host "    [MISSING] $File" -ForegroundColor Red
            $Errors += "Missing file: $File"
        }
    }

    # Test workflow-state.ps1 can be loaded
    $WorkflowScript = Join-Path $ScriptsDir "workflow-state.ps1"
    if (Test-Path $WorkflowScript) {
        try {
            # Test that PowerShell can parse the script
            $tokens = $null
            $parseErrors = $null
            $null = [System.Management.Automation.Language.Parser]::ParseFile(
                $WorkflowScript,
                [ref]$tokens,
                [ref]$parseErrors
            )
            if ($parseErrors.Count -gt 0) {
                throw "Parse errors found: $($parseErrors[0].Message)"
            }
            Write-Host "    [OK] workflow-state.ps1 syntax valid" -ForegroundColor Green
        } catch {
            Write-Host "    [ERROR] workflow-state.ps1 has syntax errors" -ForegroundColor Red
            $Errors += "Syntax error in workflow-state.ps1: $_"
        }
    }

    if ($Errors.Count -gt 0) {
        Write-Failure "Installation validation failed:"
        foreach ($ErrorItem in $Errors) {
            Write-Host "    - $ErrorItem" -ForegroundColor Red
        }
        throw "Installation incomplete. Please check errors above."
    }

    Write-Success "Installation validated successfully"
}

function Install-AdoMcp {
    <#
    .SYNOPSIS
        Installs Azure DevOps MCP server and configures it
    .DESCRIPTION
        Installs the @anthropic/azure-devops-mcp npm package and creates or updates
        the MCP configuration file with the azure-devops server entry.
    .PARAMETER ConfigPath
        Optional path to MCP config file. Defaults to ~/.copilot/.mcp.json
    .PARAMETER Force
        Force reinstallation/reconfiguration even if already configured
    .PARAMETER SkipNpmInstall
        Skip the npm global install step (useful for testing or when package is already installed)
    .EXAMPLE
        Install-AdoMcp
        Installs with default config path.
    .EXAMPLE
        Install-AdoMcp -ConfigPath "C:\custom\.mcp.json" -Force
        Installs to custom path, forcing reconfiguration.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [string]$ConfigPath = (Join-Path $env:USERPROFILE ".copilot" ".mcp.json"),
        [switch]$Force,
        [switch]$SkipNpmInstall
    )

    Write-Step "Installing Azure DevOps MCP server..."

    # Install npm package globally (unless skipped or in test mode)
    if (-not $SkipNpmInstall -and -not $env:COPILOT_TEST_MODE) {
        if ($PSCmdlet.ShouldProcess("@anthropic/azure-devops-mcp", "npm install -g")) {
            $installed = $null
            try {
                $installed = npm list -g @anthropic/azure-devops-mcp 2>$null
            } catch {
                # Package not installed
            }

            if (-not $installed -or $Force) {
                Write-Host "    Installing @anthropic/azure-devops-mcp globally..." -ForegroundColor Gray
                npm install -g @anthropic/azure-devops-mcp 2>&1 | Out-Null
                if ($LASTEXITCODE -ne 0) {
                    Write-Warning "Failed to install azure-devops-mcp globally. Will use npx to run on demand."
                } else {
                    Write-Success "Installed @anthropic/azure-devops-mcp globally"
                }
            } else {
                Write-Host "    @anthropic/azure-devops-mcp already installed globally" -ForegroundColor Gray
            }
        }
    }

    # Define the azure-devops server configuration
    $adoServerConfig = @{
        command = "npx"
        args = @("@anthropic/azure-devops-mcp")
        env = @{
            AZURE_DEVOPS_ORG_URL = '${AZURE_DEVOPS_ORG_URL}'
            AZURE_DEVOPS_PAT = '${AZURE_DEVOPS_PAT}'
        }
    }

    # Create config directory if it doesn't exist
    $configDir = Split-Path $ConfigPath -Parent
    if ($configDir -and -not (Test-Path $configDir)) {
        if ($PSCmdlet.ShouldProcess($configDir, "Create directory")) {
            New-Item -ItemType Directory -Path $configDir -Force | Out-Null
            Write-Host "    Created directory: $configDir" -ForegroundColor Gray
        }
    }

    # Create or update MCP config
    if ($PSCmdlet.ShouldProcess($ConfigPath, "Configure MCP")) {
        if (Test-Path $ConfigPath) {
            # Merge with existing config
            try {
                $existingContent = Get-Content $ConfigPath -Raw
                $existingConfig = $existingContent | ConvertFrom-Json -AsHashtable

                if (-not $existingConfig.mcpServers) {
                    $existingConfig.mcpServers = @{}
                }

                # Check if already configured (idempotency)
                if ($existingConfig.mcpServers.ContainsKey('azure-devops') -and -not $Force) {
                    Write-Host "    Azure DevOps MCP already configured in $ConfigPath" -ForegroundColor Gray
                    Write-Host "    Use -Force to reconfigure" -ForegroundColor Gray
                    return
                }

                $existingConfig.mcpServers['azure-devops'] = $adoServerConfig
                $existingConfig | ConvertTo-Json -Depth 10 | Set-Content $ConfigPath -Encoding UTF8
                Write-Success "Updated MCP config at $ConfigPath"
            } catch {
                Write-Warning "Failed to parse existing config, creating new: $_"
                $newConfig = @{
                    mcpServers = @{
                        'azure-devops' = $adoServerConfig
                    }
                }
                $newConfig | ConvertTo-Json -Depth 10 | Set-Content $ConfigPath -Encoding UTF8
                Write-Success "Created MCP config at $ConfigPath"
            }
        } else {
            # Create new config
            $newConfig = @{
                mcpServers = @{
                    'azure-devops' = $adoServerConfig
                }
            }
            $newConfig | ConvertTo-Json -Depth 10 | Set-Content $ConfigPath -Encoding UTF8
            Write-Success "Created MCP config at $ConfigPath"
        }
    }

    Write-Host ""
    Write-Host "    Required environment variables:" -ForegroundColor Yellow
    Write-Host "      AZURE_DEVOPS_ORG_URL - Your Azure DevOps organization URL" -ForegroundColor Gray
    Write-Host "      AZURE_DEVOPS_PAT     - Personal Access Token with appropriate permissions" -ForegroundColor Gray
}

function Show-PostInstallInstructions {
    <#
    .SYNOPSIS
        Display post-installation instructions
    #>
    Write-Host ""
    Write-Host "=" * 60 -ForegroundColor Cyan
    Write-Host "Installation Complete!" -ForegroundColor Green
    Write-Host "=" * 60 -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Installed to: $CopilotDir" -ForegroundColor White
    Write-Host ""
    Write-Host "Directory structure:" -ForegroundColor White
    Write-Host "  $CopilotDir\"
    Write-Host "  +-- scripts\"
    Write-Host "  |   +-- workflow-state.ps1"
    Write-Host "  +-- agents\"
    Write-Host "  |   +-- orchestrator.agent.md"
    Write-Host "  |   +-- implementer.agent.md"
    Write-Host "  |   +-- reviewer.agent.md"
    Write-Host "  |   +-- integrator.agent.md"
    Write-Host "  +-- config.json"
    Write-Host "  +-- .mcp.json (Azure DevOps MCP config)"
    Write-Host ""
    Write-Host "Azure DevOps Setup:" -ForegroundColor White
    Write-Host "  Set these environment variables before using ADO integration:" -ForegroundColor Gray
    Write-Host "  `$env:AZURE_DEVOPS_ORG_URL = 'https://dev.azure.com/your-org'" -ForegroundColor Yellow
    Write-Host "  `$env:AZURE_DEVOPS_PAT = 'your-personal-access-token'" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Usage:" -ForegroundColor White
    Write-Host "  # Initialize a new workflow"
    Write-Host "  & `"$ScriptsDir\workflow-state.ps1`" init my-feature" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  # List active workflows"
    Write-Host "  & `"$ScriptsDir\workflow-state.ps1`" list" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  # Get workflow state"
    Write-Host "  & `"$ScriptsDir\workflow-state.ps1`" get my-feature.state.json '.phase'" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Optional: Add to PATH for easier access:" -ForegroundColor White
    Write-Host "  `$env:PATH += `";$ScriptsDir`"" -ForegroundColor Yellow
    Write-Host ""
}

# Main execution
try {
    Write-Host ""
    Write-Host "Copilot CLI Workflow Installer" -ForegroundColor Cyan
    Write-Host "==============================" -ForegroundColor Cyan
    Write-Host ""

    # Check dependencies
    Test-Dependencies

    # Resolve source repository
    $ResolvedSource = Resolve-SourceRepo
    Write-Success "Source repository: $ResolvedSource"

    # Install files
    Install-WorkflowFiles -Source $ResolvedSource

    # Validate installation
    if (-not $SkipValidation) {
        Test-Installation
    }

    # Install Azure DevOps MCP integration
    Write-Host ""
    Write-Host "=== Azure DevOps Integration ===" -ForegroundColor Cyan
    Install-AdoMcp

    # Show post-install instructions
    Show-PostInstallInstructions

} catch {
    Write-Failure "Installation failed: $_"
    exit 1
}
