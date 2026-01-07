Describe "MCP Configuration" {
    BeforeAll {
        $ConfigPath = Join-Path $PSScriptRoot ".." ".mcp.json"
    }

    It "Should have .mcp.json file" {
        Test-Path $ConfigPath | Should -Be $true
    }

    It "Should contain azure-devops server configuration" {
        $config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
        $config.mcpServers.'azure-devops' | Should -Not -BeNullOrEmpty
    }

    It "Should use npx command" {
        $config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
        $config.mcpServers.'azure-devops'.command | Should -Be "npx"
    }

    It "Should reference AZURE_DEVOPS_ORG_URL env var" {
        $content = Get-Content $ConfigPath -Raw
        $content | Should -Match "AZURE_DEVOPS_ORG_URL"
    }

    It "Should reference AZURE_DEVOPS_PAT env var" {
        $content = Get-Content $ConfigPath -Raw
        $content | Should -Match "AZURE_DEVOPS_PAT"
    }
}
