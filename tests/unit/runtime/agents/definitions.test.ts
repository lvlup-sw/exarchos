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
import { claimOfRequest } from '../../../../src/verbs/settle/claim-codec.js';
import { INCOMPLETE_CLAIM_STATUSES } from '../../../../src/verbs/settle/adjudicate.js';
import { TaskCompletedData } from '../../../../src/events/schemas.js';

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
   * Only the isolated agents carry the worktree-hygiene section. Their prompt must hold no
   * `npm --prefix` and no `npm run typecheck`, so that it also fits a Cargo, pytest or dotnet
   * project. It must keep the `git -C` and "project test command" guidance.
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

/** The JSON examples in the completion report of one agent prompt, in their order. */
function completionReportExamples(prompt: string): Record<string, unknown>[] {
  const report = prompt.slice(prompt.indexOf('## Completion Report'));
  return [...report.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => {
    const parsed: unknown = JSON.parse(match[1] ?? '');
    expect(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)).toBe(true);
    return Object.fromEntries(Object.entries(parsed ?? {}));
  });
}

/** The fields of the result contract that prepare compiles: the worktree, the branch, and each completion field that settlement does not derive. */
const RESULT_CONTRACT_FIELDS: readonly string[] = [
  'worktreePath',
  'branch',
  ...Object.keys(TaskCompletedData.shape).filter((name) => !['taskId', 'evidence', 'verified'].includes(name)),
];

describe('the completion report of a claim-source agent maps onto a claim', () => {
  /**
   * The coordinator builds one claim from each report of the implementer, the fixer and the scaffolder.
   * A completed report holds result fields only, and the claim reader accepts them as the fields of a claim.
   * A report of a task that is not completed holds a status of the claim tuple and a reason.
   * A `status` of `complete` is not a claim status, so no report gives it.
   */
  it.each([IMPLEMENTER, FIXER, SCAFFOLDER].map((spec): [string, AgentSpec] => [spec.id, spec]))(
    'ClaimSourceReport_%s_GivesAClaimThatTheReaderAccepts',
    (_id, spec) => {
      const [completed, notCompleted, ...rest] = completionReportExamples(spec.systemPrompt);
      expect(rest).toEqual([]);
      expect(spec.systemPrompt).not.toContain('"status": "complete"');

      expect(completed).toBeDefined();
      expect(Object.keys(completed ?? {})).toContain('worktreePath');
      expect(Object.keys(completed ?? {}).filter((key) => !RESULT_CONTRACT_FIELDS.includes(key))).toEqual([]);
      expect(claimOfRequest({ taskId: 'task-1', fields: completed, evidence: [] }, 'claims[0]')).toMatchObject({
        taskId: 'task-1',
        fields: completed,
      });

      expect(INCOMPLETE_CLAIM_STATUSES).toContain(notCompleted?.status);
      expect(Object.keys(notCompleted ?? {})).toEqual(['status', 'reason']);
      expect(claimOfRequest({ taskId: 'task-1', ...notCompleted }, 'claims[0]')).toMatchObject({
        status: notCompleted?.status,
      });
      for (const status of INCOMPLETE_CLAIM_STATUSES) {
        expect(spec.systemPrompt, `${spec.id} does not name the status ${status}`).toContain(`\`${status}\``);
      }
    },
  );
});
