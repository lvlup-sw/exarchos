BeforeAll {
    $AgentPath = Join-Path $PSScriptRoot ".." "agents" "reviewer.agent.md"
}

Describe "Reviewer Agent ADO Support" {
    It "Should contain ADO thread structure documentation" {
        $content = Get-Content $AgentPath -Raw
        $content | Should -Match "threadContext|ADO thread"
    }

    It "Should contain priority mapping for ADO" {
        $content = Get-Content $AgentPath -Raw
        $content | Should -Match "P[1-4].*priority|priority.*P[1-4]"
    }

    It "Should document thread status values" {
        $content = Get-Content $AgentPath -Raw
        $content | Should -Match "active|resolved|won't fix"
    }

    It "Should maintain existing review stages" {
        $content = Get-Content $AgentPath -Raw
        $content | Should -Match "Stage 1.*Spec Review"
    }
}
