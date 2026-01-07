#Requires -Version 5.1
<#
.SYNOPSIS
    Workflow state management for Copilot CLI
.DESCRIPTION
    Manages workflow state files for the development workflow.
    This is a PowerShell port of the bash workflow-state.sh script.
    Supports both GitHub and Azure DevOps platforms (v1.1).
.PARAMETER Command
    The command to execute: init, init-ado, list, get, set, summary, reconcile, next-action
.PARAMETER Arg1
    First argument (state file or feature ID depending on command)
.PARAMETER Arg2
    Second argument (jq query or filter depending on command)
.PARAMETER Organization
    Azure DevOps organization name (required for init-ado command)
.PARAMETER Project
    Azure DevOps project name (required for init-ado command)
.PARAMETER RepositoryId
    Azure DevOps repository GUID (required for init-ado command)
.EXAMPLE
    .\workflow-state.ps1 init my-feature
    Creates a new state file for the 'my-feature' workflow (GitHub platform, v1.0).
.EXAMPLE
    .\workflow-state.ps1 init-ado my-feature -Organization "my-org" -Project "my-project" -RepositoryId "guid-123"
    Creates a new state file for Azure DevOps workflow (v1.1).
.EXAMPLE
    .\workflow-state.ps1 get state.json '.phase'
    Gets the phase field from the state file.
.EXAMPLE
    .\workflow-state.ps1 set state.json '.phase = "delegate"'
    Updates the phase field in the state file.
.EXAMPLE
    .\workflow-state.ps1 list
    Lists all active (non-completed) workflows.
.EXAMPLE
    .\workflow-state.ps1 summary state.json
    Outputs a minimal summary for context restoration.
.EXAMPLE
    .\workflow-state.ps1 next-action state.json
    Determines the next auto-continue action.
.NOTES
    Requires jq for JSON manipulation. Install with: winget install jqlang.jq
#>

param(
    [Parameter(Position=0, Mandatory=$true)]
    [ValidateSet('init', 'init-ado', 'list', 'get', 'set', 'summary', 'reconcile', 'next-action')]
    [string]$Command,

    [Parameter(Position=1)]
    [string]$Arg1,

    [Parameter(Position=2)]
    [string]$Arg2,

    # ADO-specific parameters for init-ado command
    [string]$Organization,
    [string]$Project,
    [string]$RepositoryId
)

# Verify jq is available
if (-not (Get-Command jq -ErrorAction SilentlyContinue)) {
    throw "jq is required. Install with: winget install jqlang.jq"
}

# Auto-detect repo root - works from any directory within a git repo
$RepoRoot = git rev-parse --show-toplevel 2>$null
$script:InGitRepo = $LASTEXITCODE -eq 0
if (-not $script:InGitRepo) {
    $RepoRoot = Get-Location
    Write-Host "WARNING: Not in a git repository. State files will be created in current directory." -ForegroundColor Yellow
}

# Allow override via environment variable (for testing)
if ($env:WORKFLOW_STATE_DIR) {
    $StateDir = $env:WORKFLOW_STATE_DIR
} else {
    $StateDir = Join-Path $RepoRoot "docs/workflow-state"
}

# Ensure state directory exists
if (-not (Test-Path $StateDir)) {
    New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
}

function Resolve-StateFile {
    <#
    .SYNOPSIS
        Resolves state file paths - handles both relative and absolute paths
    #>
    param([string]$Input)

    if ([System.IO.Path]::IsPathRooted($Input)) {
        # Absolute path - use as-is
        return $Input
    }
    elseif ($Input -like "docs/workflow-state/*") {
        # Relative from repo root
        return Join-Path $RepoRoot $Input
    }
    elseif ($Input -like "*.state.json") {
        # Just filename - prepend STATE_DIR
        return Join-Path $StateDir $Input
    }
    else {
        # Assume relative from repo root
        return Join-Path $RepoRoot $Input
    }
}

function Invoke-Init {
    <#
    .SYNOPSIS
        Initialize a new workflow state file
    #>
    param([string]$FeatureId)

    if (-not $FeatureId) {
        Write-Error "Usage: workflow-state.ps1 init <feature-id>"
        exit 1
    }

    $StateFile = Join-Path $StateDir "$FeatureId.state.json"
    $Now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

    if (Test-Path $StateFile) {
        Write-Error "ERROR: State file already exists: $StateFile"
        exit 1
    }

    $State = @{
        version = "1.0"
        featureId = $FeatureId
        createdAt = $Now
        updatedAt = $Now
        phase = "ideate"
        platform = "github"
        artifacts = @{
            design = $null
            plan = $null
            pr = $null
        }
        tasks = @()
        worktrees = @{}
        julesSessions = @{}
        reviews = @{}
        synthesis = @{
            integrationBranch = $null
            mergeOrder = @()
            mergedBranches = @()
            prUrl = $null
            prFeedback = @()
        }
    }

    $State | ConvertTo-Json -Depth 10 | Set-Content -Path $StateFile -Encoding UTF8
    Write-Output "Created: $StateFile"
}

function Invoke-InitAdo {
    <#
    .SYNOPSIS
        Initialize a new workflow state file for Azure DevOps
    .DESCRIPTION
        Creates a workflow state file with ADO-specific configuration fields
        including organization, project, and repositoryId.
    .PARAMETER FeatureId
        Unique identifier for the feature workflow
    .PARAMETER Organization
        Azure DevOps organization name
    .PARAMETER Project
        Azure DevOps project name
    .PARAMETER RepositoryId
        Azure DevOps repository GUID
    #>
    param(
        [Parameter(Mandatory=$true)]
        [string]$FeatureId,
        [Parameter(Mandatory=$true)]
        [string]$Organization,
        [Parameter(Mandatory=$true)]
        [string]$Project,
        [Parameter(Mandatory=$true)]
        [string]$RepositoryId
    )

    $StateFile = Join-Path $StateDir "$FeatureId.state.json"
    $Now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

    if (Test-Path $StateFile) {
        Write-Error "ERROR: State file already exists: $StateFile"
        exit 1
    }

    $State = @{
        version = "1.1"
        featureId = $FeatureId
        createdAt = $Now
        updatedAt = $Now
        phase = "ideate"
        platform = "azure-devops"
        ado = @{
            organization = $Organization
            project = $Project
            repositoryId = $RepositoryId
        }
        artifacts = @{
            design = $null
            plan = $null
            pr = $null
        }
        tasks = @()
        worktrees = @{}
        julesSessions = @{}
        reviews = @{}
        synthesis = @{
            integrationBranch = $null
            mergeOrder = @()
            mergedBranches = @()
            prUrl = $null
            prFeedback = @()
        }
    }

    $State | ConvertTo-Json -Depth 10 | Set-Content -Path $StateFile -Encoding UTF8
    Write-Output "Created ADO workflow: $StateFile"
}

function Invoke-List {
    <#
    .SYNOPSIS
        List all active (non-completed) workflows
    #>
    Write-Output "Active Workflows:"
    Write-Output ""

    $StateFiles = Get-ChildItem -Path $StateDir -Filter "*.state.json" -ErrorAction SilentlyContinue

    foreach ($File in $StateFiles) {
        $Feature = Get-Content $File.FullName -Raw | jq -r '.featureId'
        $Phase = Get-Content $File.FullName -Raw | jq -r '.phase'
        $Updated = Get-Content $File.FullName -Raw | jq -r '.updatedAt'

        if ($Phase -ne "completed") {
            $FormattedLine = "  {0,-30} {1,-12} {2}" -f $Feature, "[$Phase]", $Updated
            Write-Output $FormattedLine
        }
    }
}

function Invoke-Get {
    <#
    .SYNOPSIS
        Get state or specific field using jq query
    #>
    param(
        [string]$StateFileInput,
        [string]$Query = "."
    )

    if (-not $StateFileInput) {
        Write-Error "Usage: workflow-state.ps1 get <state-file> [jq-query]"
        exit 1
    }

    $StateFile = Resolve-StateFile $StateFileInput

    if (-not (Test-Path $StateFile)) {
        Write-Error "ERROR: State file not found: $StateFile"
        exit 1
    }

    Get-Content $StateFile -Raw | jq $Query
}

function Invoke-Set {
    <#
    .SYNOPSIS
        Update state using jq filter
    #>
    param(
        [string]$StateFileInput,
        [string]$Filter
    )

    if (-not $StateFileInput -or -not $Filter) {
        Write-Error "Usage: workflow-state.ps1 set <state-file> <jq-filter>"
        exit 1
    }

    $StateFile = Resolve-StateFile $StateFileInput
    $Now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

    if (-not (Test-Path $StateFile)) {
        Write-Error "ERROR: State file not found: $StateFile"
        exit 1
    }

    # Update with new value and timestamp
    $TempFile = [System.IO.Path]::GetTempFileName()
    $FullFilter = "$Filter | .updatedAt = `"$Now`""

    $Result = Get-Content $StateFile -Raw | jq $FullFilter
    if ($LASTEXITCODE -ne 0) {
        Remove-Item -Path $TempFile -ErrorAction SilentlyContinue
        Write-Error "ERROR: Invalid jq filter or JSON error"
        exit 1
    }
    $Result | Set-Content -Path $TempFile -Encoding UTF8
    Move-Item -Path $TempFile -Destination $StateFile -Force

    Write-Output "Updated: $StateFile"
}

function Invoke-Summary {
    <#
    .SYNOPSIS
        Output minimal summary for context restoration
    #>
    param([string]$StateFileInput)

    if (-not $StateFileInput) {
        Write-Error "Usage: workflow-state.ps1 summary <state-file>"
        exit 1
    }

    $StateFile = Resolve-StateFile $StateFileInput

    if (-not (Test-Path $StateFile)) {
        Write-Error "ERROR: State file not found: $StateFile"
        exit 1
    }

    $Content = Get-Content $StateFile -Raw
    $Feature = $Content | jq -r '.featureId'
    $Phase = $Content | jq -r '.phase'
    $Updated = $Content | jq -r '.updatedAt'
    $Design = $Content | jq -r '.artifacts.design // "not created"'
    $Plan = $Content | jq -r '.artifacts.plan // "not created"'
    $Pr = $Content | jq -r '.artifacts.pr // "not created"'
    $TotalTasks = $Content | jq '.tasks | length'
    $CompleteTasks = $Content | jq '[.tasks[] | select(.status == "complete")] | length'

    Write-Output "## Workflow Context Restored"
    Write-Output ""
    Write-Output "**Feature:** $Feature"
    Write-Output "**Phase:** $Phase"
    Write-Output "**Last Updated:** $Updated"
    Write-Output ""
    Write-Output "### Artifacts"
    Write-Output "- Design: ``$Design``"
    Write-Output "- Plan: ``$Plan``"
    Write-Output "- PR: $Pr"
    Write-Output ""
    Write-Output "### Task Progress"
    Write-Output "- Completed: $CompleteTasks / $TotalTasks"
    Write-Output ""

    # List incomplete tasks
    $Pending = $Content | jq -r '.tasks[] | select(.status != "complete") | "- [\(.status)] \(.id): \(.title)"'
    if ($Pending) {
        Write-Output "### Pending Tasks"
        Write-Output $Pending
        Write-Output ""
    }

    # List active worktrees
    $Worktrees = $Content | jq -r '.worktrees | to_entries[] | select(.value.status == "active") | "- \(.key) (\(.value.branch))"'
    if ($Worktrees) {
        Write-Output "### Active Worktrees"
        Write-Output $Worktrees
        Write-Output ""
    }

    # Suggest next action
    Write-Output "### Next Action"
    switch ($Phase) {
        "ideate" {
            Write-Output "Continue design exploration or run ``/plan``"
        }
        "plan" {
            Write-Output "Run ``/delegate $Plan``"
        }
        "delegate" {
            if ($CompleteTasks -eq $TotalTasks) {
                Write-Output "All tasks complete. Run ``/review $Plan``"
            } else {
                Write-Output "Monitor task completion, then run ``/review``"
            }
        }
        "review" {
            Write-Output "Address review issues or run ``/synthesize``"
        }
        "synthesize" {
            if ($Pr -ne "not created") {
                Write-Output "PR created. Merge or address feedback with ``/delegate --pr-fixes $Pr``"
            } else {
                Write-Output "Run ``/synthesize`` to create PR"
            }
        }
        default {
            Write-Output "Check state file for details"
        }
    }
}

function Invoke-Reconcile {
    <#
    .SYNOPSIS
        Reconcile state with reality (git worktrees, branches)
    #>
    param([string]$StateFileInput)

    if (-not $script:InGitRepo) {
        Write-Error "ERROR: reconcile command requires a git repository"
        exit 1
    }

    if (-not $StateFileInput) {
        Write-Error "Usage: workflow-state.ps1 reconcile <state-file>"
        exit 1
    }

    $StateFile = Resolve-StateFile $StateFileInput

    if (-not (Test-Path $StateFile)) {
        Write-Error "ERROR: State file not found: $StateFile"
        exit 1
    }

    Write-Output "Reconciling state with reality..."
    Write-Output ""

    $Content = Get-Content $StateFile -Raw

    # Check worktrees
    Write-Output "## Git Worktrees"
    $StateWorktrees = $Content | jq -r '.worktrees | keys[]' 2>$null
    $ActualWorktrees = @(git worktree list --porcelain 2>$null | Where-Object { $_ -match "^worktree " } | ForEach-Object { ($_ -split " ", 2)[1] })

    if ($StateWorktrees) {
        foreach ($Wt in $StateWorktrees -split "`n") {
            if ($Wt -and $ActualWorktrees -contains $Wt) {
                Write-Output "  [OK] $Wt exists"
            } elseif ($Wt) {
                Write-Output "  [MISSING] $Wt not found"
            }
        }
    }

    # Check branches
    Write-Output ""
    Write-Output "## Git Branches"
    $Branches = $Content | jq -r '.tasks[].branch // empty'

    if ($Branches) {
        foreach ($Branch in $Branches -split "`n") {
            if ($Branch) {
                $BranchExists = git show-ref --verify --quiet "refs/heads/$Branch" 2>$null
                if ($LASTEXITCODE -eq 0) {
                    Write-Output "  [OK] $Branch exists"
                } else {
                    Write-Output "  [MISSING] $Branch not found"
                }
            }
        }
    }

    Write-Output ""
    Write-Output "Reconciliation complete."
}

function Invoke-NextAction {
    <#
    .SYNOPSIS
        Determine next auto-continue action based on current state
    #>
    param([string]$StateFileInput)

    if (-not $StateFileInput) {
        Write-Error "Usage: workflow-state.ps1 next-action <state-file>"
        exit 1
    }

    $StateFile = Resolve-StateFile $StateFileInput

    if (-not (Test-Path $StateFile)) {
        Write-Output "ERROR:state-not-found"
        exit 1
    }

    $Content = Get-Content $StateFile -Raw
    $Phase = $Content | jq -r '.phase'
    $Plan = $Content | jq -r '.artifacts.plan // ""'
    $Pr = $Content | jq -r '.synthesis.prUrl // ""'
    $TotalTasks = [int]($Content | jq '.tasks | length')
    $CompleteTasks = [int]($Content | jq '[.tasks[] | select(.status == "complete")] | length')

    # Check review status
    $SpecPending = [int]($Content | jq '[.tasks[] | select(.reviewStatus.specReview == null or .reviewStatus.specReview == "pending")] | length')
    $SpecFailed = [int]($Content | jq '[.tasks[] | select(.reviewStatus.specReview == "fail")] | length')
    $QualityPending = [int]($Content | jq '[.tasks[] | select(.reviewStatus.qualityReview == null or .reviewStatus.qualityReview == "pending")] | length')
    $QualityFailed = [int]($Content | jq '[.tasks[] | select(.reviewStatus.qualityReview == "needs_fixes" or .reviewStatus.qualityReview == "blocked")] | length')

    switch ($Phase) {
        "ideate" {
            # Human checkpoint - design confirmation
            Write-Output "WAIT:human-checkpoint:design-confirmation"
        }
        "plan" {
            if ($Plan -and $Plan -ne "null") {
                # Plan saved, auto-continue to delegate
                Write-Output "AUTO:delegate:$Plan"
            } else {
                Write-Output "WAIT:incomplete:plan-not-saved"
            }
        }
        "delegate" {
            if ($TotalTasks -eq 0) {
                Write-Output "WAIT:incomplete:no-tasks-defined"
            } elseif ($CompleteTasks -eq $TotalTasks) {
                # All tasks complete, auto-continue to review
                Write-Output "AUTO:review:$Plan"
            } else {
                Write-Output "WAIT:in-progress:tasks-$CompleteTasks-of-$TotalTasks"
            }
        }
        "review" {
            if ($SpecFailed -gt 0 -or $QualityFailed -gt 0) {
                # Review failed, auto-continue to fixes
                Write-Output "AUTO:delegate:--fixes $Plan"
            } elseif ($SpecPending -gt 0 -or $QualityPending -gt 0) {
                # Reviews still pending
                Write-Output "WAIT:in-progress:reviews-pending"
            } else {
                # All reviews passed, auto-continue to synthesize
                $Feature = $Content | jq -r '.featureId'
                Write-Output "AUTO:synthesize:$Feature"
            }
        }
        "synthesize" {
            if ($Pr -and $Pr -ne "null" -and $Pr -ne "") {
                # PR created - human checkpoint for merge confirmation
                Write-Output "WAIT:human-checkpoint:merge-confirmation"
            } else {
                Write-Output "WAIT:incomplete:pr-not-created"
            }
        }
        "completed" {
            Write-Output "DONE"
        }
        "blocked" {
            Write-Output "WAIT:blocked:requires-redesign"
        }
        default {
            Write-Output "UNKNOWN:$Phase"
        }
    }
}

# Main dispatcher
switch ($Command) {
    'init' { Invoke-Init $Arg1 }
    'init-ado' {
        # Validate required ADO parameters
        if (-not $Organization) {
            Write-Error "ERROR: -Organization parameter is required for init-ado"
            exit 1
        }
        if (-not $Project) {
            Write-Error "ERROR: -Project parameter is required for init-ado"
            exit 1
        }
        if (-not $RepositoryId) {
            Write-Error "ERROR: -RepositoryId parameter is required for init-ado"
            exit 1
        }
        Invoke-InitAdo -FeatureId $Arg1 -Organization $Organization -Project $Project -RepositoryId $RepositoryId
    }
    'list' { Invoke-List }
    'get' { Invoke-Get $Arg1 $Arg2 }
    'set' { Invoke-Set $Arg1 $Arg2 }
    'summary' { Invoke-Summary $Arg1 }
    'reconcile' { Invoke-Reconcile $Arg1 }
    'next-action' { Invoke-NextAction $Arg1 }
}
