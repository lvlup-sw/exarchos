#Requires -Version 5.1
<#
.SYNOPSIS
    Azure DevOps authentication helpers for Copilot CLI workflow
.DESCRIPTION
    Provides functions to retrieve ADO tokens and test connectivity.
    Supports PAT-based auth and Azure CLI fallback.
.NOTES
    Token retrieval priority:
    1. AZURE_DEVOPS_EXT_PAT environment variable (az devops CLI standard)
    2. Azure CLI access token (requires 'az login')
#>

function Get-AdoToken {
    <#
    .SYNOPSIS
        Retrieves an Azure DevOps authentication token
    .DESCRIPTION
        First checks AZURE_DEVOPS_EXT_PAT environment variable.
        Falls back to Azure CLI if PAT not set.
    .OUTPUTS
        String - The authentication token
    .EXAMPLE
        $token = Get-AdoToken
        # Returns token from PAT env var or Azure CLI
    .EXAMPLE
        $env:AZURE_DEVOPS_EXT_PAT = "your-pat-here"
        $token = Get-AdoToken
        # Returns the PAT token directly
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param()

    # Try PAT first - fastest and most explicit auth method
    # AZURE_DEVOPS_EXT_PAT is the standard env var recognized by az devops CLI
    if ($env:AZURE_DEVOPS_EXT_PAT) {
        Write-Verbose "Using AZURE_DEVOPS_EXT_PAT environment variable"
        return $env:AZURE_DEVOPS_EXT_PAT
    }

    # Fall back to Azure CLI
    Write-Verbose "AZURE_DEVOPS_EXT_PAT not set, attempting Azure CLI fallback"
    try {
        # Azure DevOps resource ID for token acquisition
        $adoResourceId = "499b84ac-1321-427f-aa17-267ca6975798"

        $token = az account get-access-token `
            --resource $adoResourceId `
            --query accessToken -o tsv 2>$null

        if ($LASTEXITCODE -ne 0 -or -not $token) {
            throw "Azure CLI token retrieval failed with exit code $LASTEXITCODE"
        }

        Write-Verbose "Successfully retrieved token from Azure CLI"
        return $token
    }
    catch {
        $errorMessage = @(
            "Failed to get ADO token.",
            "Set AZURE_DEVOPS_EXT_PAT environment variable or run 'az login' first.",
            "Error: $_"
        ) -join " "

        throw $errorMessage
    }
}

function Test-AdoConnection {
    <#
    .SYNOPSIS
        Tests connectivity to an Azure DevOps organization
    .DESCRIPTION
        Attempts to authenticate and make a simple API call to verify
        that the current credentials can access the specified organization.
    .PARAMETER Organization
        The ADO organization name (without full URL).
        Example: "my-org" for https://dev.azure.com/my-org
    .OUTPUTS
        Boolean - True if connection successful, False otherwise
    .EXAMPLE
        Test-AdoConnection -Organization "my-org"
        # Returns $true if connected, $false otherwise
    .EXAMPLE
        if (Test-AdoConnection -Organization "my-org") {
            Write-Host "Connected to ADO"
        }
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory = $true, Position = 0)]
        [ValidateNotNullOrEmpty()]
        [string]$Organization
    )

    try {
        Write-Verbose "Testing connection to organization: $Organization"

        # First verify we can get a token
        $token = Get-AdoToken
        Write-Verbose "Token retrieved successfully"

        # Export token to env var so az devops CLI can use it
        # AZURE_DEVOPS_EXT_PAT is the standard env var recognized by az devops
        $env:AZURE_DEVOPS_EXT_PAT = $token

        # Test with a simple API call to list projects
        $orgUrl = "https://dev.azure.com/$Organization"
        Write-Verbose "Testing API access to: $orgUrl"

        $result = az devops project list `
            --org $orgUrl `
            --query "[0].name" -o tsv 2>$null

        if ($LASTEXITCODE -eq 0) {
            Write-Verbose "Connection test passed"
            return $true
        }
        else {
            Write-Verbose "Connection test failed with exit code: $LASTEXITCODE"
            return $false
        }
    }
    catch {
        Write-Warning "Connection test failed: $_"
        return $false
    }
}

# Export functions when loaded as module
if ($MyInvocation.MyCommand.ScriptBlock.Module) {
    Export-ModuleMember -Function Get-AdoToken, Test-AdoConnection
}
