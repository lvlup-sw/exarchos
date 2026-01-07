BeforeAll {
    $InstructionsPath = Join-Path $PSScriptRoot ".." "copilot-instructions.md"
}

Describe "Copilot Instructions ADO Support" {
    It "Should contain ADO platform reference" {
        $content = Get-Content $InstructionsPath -Raw
        $content | Should -Match "azure-devops|Azure DevOps"
    }

    It "Should contain MCP tool list" {
        $content = Get-Content $InstructionsPath -Raw
        $content | Should -Match "mcp_ado"
    }

    It "Should document ADO state initialization" {
        $content = Get-Content $InstructionsPath -Raw
        $content | Should -Match "init-ado"
    }

    It "Should explain platform detection" {
        $content = Get-Content $InstructionsPath -Raw
        $content | Should -Match "platform.*detection|\.platform"
    }

    It "Should maintain existing TDD requirements" {
        $content = Get-Content $InstructionsPath -Raw
        $content | Should -Match "NO PRODUCTION CODE WITHOUT A FAILING TEST"
    }
}
