BeforeAll {
    $DocPath = Join-Path $PSScriptRoot ".." "docs" "ado-cli-reference.md"
}

Describe "ADO CLI Reference Documentation" {
    It "Should have ado-cli-reference.md file" {
        Test-Path $DocPath | Should -Be $true
    }

    It "Should contain PR create command" {
        $content = Get-Content $DocPath -Raw
        $content | Should -Match "az repos pr create"
    }

    It "Should contain PR update command" {
        $content = Get-Content $DocPath -Raw
        $content | Should -Match "az repos pr update"
    }

    It "Should contain work item link command" {
        $content = Get-Content $DocPath -Raw
        $content | Should -Match "az boards work-item"
    }

    It "Should document authentication" {
        $content = Get-Content $DocPath -Raw
        $content | Should -Match "az login|AZURE_DEVOPS_PAT"
    }

    It "Should include troubleshooting section" {
        $content = Get-Content $DocPath -Raw
        $content | Should -Match "Troubleshooting|Common Issues"
    }
}
