BeforeAll {
    $SkillPath = Join-Path $PSScriptRoot ".." "skills" "synthesis" "SKILL.md"
}

Describe "Synthesis Skill ADO Support" {
    It "Should contain ADO PR creation section" {
        $content = Get-Content $SkillPath -Raw
        $content | Should -Match "mcp_ado_repo_create_pull_request"
    }

    It "Should contain MCP tool references" {
        $content = Get-Content $SkillPath -Raw
        $content | Should -Match "mcp_ado"
    }

    It "Should contain work item linking" {
        $content = Get-Content $SkillPath -Raw
        $content | Should -Match "mcp_ado_wit_link_work_item_to_pull_request"
    }

    It "Should document ADO PR URL format" {
        $content = Get-Content $SkillPath -Raw
        $content | Should -Match "dev\.azure\.com.*pullrequest"
    }

    It "Should maintain GitHub flow" {
        $content = Get-Content $SkillPath -Raw
        $content | Should -Match "gh pr create"
    }
}
