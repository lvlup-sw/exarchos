BeforeAll {
    $AgentPath = Join-Path $PSScriptRoot ".." "agents" "orchestrator.agent.md"
}

Describe "Orchestrator Agent ADO Support" {
    It "Should contain ADO MCP tools section" {
        $content = Get-Content $AgentPath -Raw
        $content | Should -Match "mcp_ado"
    }

    It "Should document ADO PR URL format" {
        $content = Get-Content $AgentPath -Raw
        $content | Should -Match "dev\.azure\.com.*pullrequest"
    }

    It "Should explain AB# work item syntax" {
        $content = Get-Content $AgentPath -Raw
        $content | Should -Match "AB#"
    }

    It "Should maintain existing constraints" {
        $content = Get-Content $AgentPath -Raw
        $content | Should -Match "MUST NOT.*Write implementation code"
    }
}
