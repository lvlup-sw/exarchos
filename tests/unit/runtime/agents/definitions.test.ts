// Agent specs declare a `posture`, not Claude-shaped `tools`. Runtime tool names
// belong in the adapters.
//
// `resolveCapabilities` derives the capability set from `posture` and `id`. An
// `AgentSpec` holds no `capabilities` field, so the tests assert against the
// resolved set.

import { describe, it, expect } from 'vitest';
import { IMPLEMENTER, FIXER, REVIEWER, SCAFFOLDER, ALL_AGENT_SPECS } from '../../../../src/runtime/agents/definitions.js';
import type { AgentSpec } from '../../../../src/runtime/agents/types.js';
import { resolveCapabilities } from '../../../../src/workflow/capabilities/posture-mapping.js';

describe('AgentSpec capability declarations', () => {
  it('AgentSpec_DeclaresCapabilities_NotClaudeTools', () => {
    const caps = resolveCapabilities(IMPLEMENTER.posture, IMPLEMENTER.id);
    for (const cap of ['fs:read', 'fs:write', 'shell:exec', 'mcp:exarchos', 'isolation:worktree'] as const) {
      expect(caps.has(cap)).toBe(true);
    }

    expect((IMPLEMENTER as unknown as Record<string, unknown>).tools).toBeUndefined();
  });

  it('AgentSpec_AllFourSpecs_DeclareCapabilities', () => {
    for (const spec of ALL_AGENT_SPECS) {
      const caps = resolveCapabilities(spec.posture, spec.id);
      expect(caps.size).toBeGreaterThan(0);
    }
  });

  it('AgentSpec_FixerCapabilities', () => {
    const caps = resolveCapabilities(FIXER.posture, FIXER.id);
    for (const cap of ['fs:read', 'fs:write', 'shell:exec', 'mcp:exarchos'] as const) {
      expect(caps.has(cap)).toBe(true);
    }
  });

  /** The `mcp:exarchos:readonly` capability tier enforces the trust boundary of the reviewer. */
  it('AgentSpec_ReviewerCapabilities_ReadOnly', () => {
    const caps = resolveCapabilities(REVIEWER.posture, REVIEWER.id);
    expect(caps.has('fs:read')).toBe(true);
    expect(caps.has('mcp:exarchos:readonly')).toBe(true);
    expect(caps.has('fs:write')).toBe(false);
  });

  /**
   * The dispatch gate denies a mutating action only when the readonly tier is present and
   * `mcp:exarchos` is absent.
   */
  it('REVIEWER_Capabilities_UsesReadonlyMCP', () => {
    const caps = resolveCapabilities(REVIEWER.posture, REVIEWER.id);
    expect(caps.has('mcp:exarchos:readonly')).toBe(true);
    expect(caps.has('mcp:exarchos')).toBe(false);
  });

  /** The dispatch gate enforces the trust boundary, so the prompt holds no "Forbidden MCP Actions" block. */
  it('REVIEWER_SystemPrompt_LacksForbiddenActionsBlock', () => {
    expect(REVIEWER.systemPrompt).not.toContain('Forbidden MCP Actions');
    expect(REVIEWER.systemPrompt).not.toContain('You MUST NOT call any other MCP action');
    expect(REVIEWER.systemPrompt).not.toContain('exarchos_event append/batch_append');
  });

  it('REVIEWER_SystemPrompt_PreservesNonForbiddenSections', () => {
    expect(REVIEWER.systemPrompt).toContain('## Review Scope');
    expect(REVIEWER.systemPrompt).toContain('## Design Requirements');
    expect(REVIEWER.systemPrompt).toContain('## Review Protocol');
    expect(REVIEWER.systemPrompt).toContain('## Completion Report');
    expect(REVIEWER.systemPrompt).toContain('{{reviewScope}}');
    expect(REVIEWER.systemPrompt).toContain('{{designRequirements}}');
    expect(REVIEWER.systemPrompt).toContain('READ-ONLY access');
  });

  it('AgentSpec_ScaffolderCapabilities', () => {
    const caps = resolveCapabilities(SCAFFOLDER.posture, SCAFFOLDER.id);
    for (const cap of ['fs:read', 'fs:write', 'shell:exec', 'mcp:exarchos'] as const) {
      expect(caps.has(cap)).toBe(true);
    }
  });

  /**
   * The Claude adapter renders `isolation: worktree` only when the resolved set holds
   * `isolation:worktree`. Without it, parallel dispatch of a write-capable agent corrupts the
   * main worktree of the orchestrator.
   */
  it('FIXER_capabilities_includesIsolationWorktree', () => {
    const caps = resolveCapabilities(FIXER.posture, FIXER.id);
    expect(caps.has('isolation:worktree')).toBe(true);
  });

  it('SCAFFOLDER_capabilities_includesIsolationWorktree', () => {
    const caps = resolveCapabilities(SCAFFOLDER.posture, SCAFFOLDER.id);
    expect(caps.has('isolation:worktree')).toBe(true);
  });

  /** The reviewer holds no write or shell capability, so it needs no worktree isolation. */
  it('REVIEWER_capabilities_readOnlyDoesNotRequireIsolation', () => {
    const caps = resolveCapabilities(REVIEWER.posture, REVIEWER.id);
    expect(caps.has('fs:write')).toBe(false);
    expect(caps.has('shell:exec')).toBe(false);
    expect(caps.has('isolation:worktree')).toBe(false);
  });

  it('AgentSpec_RejectsUnknownPosture_TypecheckFails', () => {
    // @ts-expect-error - 'bogus' is not a valid AgentPosture
    const bad: AgentSpec = {
      id: 'implementer',
      description: 'x',
      systemPrompt: 'x',
      posture: 'bogus',
      model: 'inherit',
      skills: [],
      validationRules: [],
      resumable: false,
    };
    expect(bad).toBeDefined();
  });

  /**
   * Some runtimes (Copilot CLI, generic MCP) start a subagent in the cwd of the parent repository.
   * Without a `cd` into the worktree first, the worktree verification fails and the agent stops.
   * The setup section must come before the verification and give a bash form and a PowerShell form.
   */
  it('ImplementerSpec_PromptBody_IncludesCdIntoWorktreeBeforeVerification', () => {
    const prompt = IMPLEMENTER.systemPrompt;

    const wdSetupIndex = prompt.indexOf('## Working Directory Setup');
    expect(wdSetupIndex, 'IMPLEMENTER systemPrompt must include "## Working Directory Setup"').toBeGreaterThan(-1);

    const verificationIndex = prompt.indexOf('## Worktree Verification');
    expect(verificationIndex).toBeGreaterThan(-1);
    expect(wdSetupIndex).toBeLessThan(verificationIndex);

    const setupSection = prompt.slice(wdSetupIndex, verificationIndex);
    expect(setupSection).toMatch(/\bcd\b/);
    expect(setupSection).toMatch(/Set-Location/);
  });

  /**
   * `exarchos run-tests` resolves the test command of the consumer at runtime, from its cwd. The
   * agent files ship static, so a toolchain command resolved at generation time fails for a
   * consumer on another toolchain.
   */
  it('Hooks_PostTestCommand_IsRuntimeResolvingExarchosRunTests_NotBakedToolchain', () => {
    for (const spec of ALL_AGENT_SPECS) {
      const postTestRules = (spec.validationRules ?? []).filter(
        (r) => r.trigger === 'post-test' && typeof r.command === 'string',
      );
      for (const rule of postTestRules) {
        const cmd = rule.command as string;
        expect(cmd, `${spec.id} post-test command must be 'exarchos run-tests'`).toBe(
          'exarchos run-tests',
        );
        expect(
          /npm |yarn |pnpm |cargo |pytest|dotnet |\{\{testCommand\}\}/.test(cmd),
          `${spec.id} post-test command must not bake a toolchain command: ${cmd}`,
        ).toBe(false);
      }
    }
  });

  /**
   * Only the isolated agents carry the worktree-hygiene section. The section must name no `npm`
   * command, so that it also fits a Cargo, pytest or dotnet project.
   */
  it('WorktreeHygiene_Prose_IsToolchainNeutral_NoHardcodedNpm', () => {
    for (const spec of ALL_AGENT_SPECS) {
      const prompt = spec.systemPrompt;
      if (!prompt.includes('Worktree Hygiene')) continue;

      expect(
        prompt.includes('npm --prefix'),
        `${spec.id} worktree-hygiene prose must not hardcode 'npm --prefix'`,
      ).toBe(false);
      expect(
        prompt.includes('npm run typecheck'),
        `${spec.id} worktree-hygiene prose must not hardcode 'npm run typecheck'`,
      ).toBe(false);

      expect(prompt, `${spec.id} must keep 'git -C <worktree>' guidance`).toContain(
        'git -C',
      );
      expect(
        prompt.toLowerCase(),
        `${spec.id} must describe running the project test command from the worktree`,
      ).toContain('project test command');
    }
  });
});
