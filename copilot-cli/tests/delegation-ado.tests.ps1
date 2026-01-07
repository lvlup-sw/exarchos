BeforeAll {
    $SkillPath = Join-Path $PSScriptRoot ".." "skills" "delegation" "SKILL.md"
}

Describe "Delegation Skill ADO Support" {
    It "Should contain ADO branch creation section" {
        $content = Get-Content $SkillPath -Raw
        $content | Should -Match "mcp_ado_repo_create_branch"
    }

    It "Should contain MCP tool reference for branch creation" {
        $content = Get-Content $SkillPath -Raw
        $content | Should -Match "mcp_ado_repo_create_branch"
    }

    It "Should document platform detection" {
        $content = Get-Content $SkillPath -Raw
        $content | Should -Match "azure-devops|ADO|platform"
    }

    It "Should maintain git worktree commands" {
        $content = Get-Content $SkillPath -Raw
        $content | Should -Match "git worktree add"
    }
}
