// ─── Capability-Declared Agent Spec Tests ──────────────────────────────────
//
// Verifies that agent specs declare runtime-agnostic capabilities instead
// of Claude-shaped `tools`. Runtime tool naming belongs in adapters, not in
// the domain registry.
//
// Post-#1333: capabilities are derived from `posture` + `id` via the
// resolver in `capabilities/posture-mapping.ts`. The runtime interface
// no longer carries a `capabilities[]` field; tests assert against the
// resolved set instead.
//
// See docs/designs/archive/2026-04-25-delegation-runtime-parity.md §3 and
// docs/designs/archive/2026-05-09-v2-10-0-preview-1-substrate-stabilization.md.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { IMPLEMENTER, FIXER, REVIEWER, SCAFFOLDER, ALL_AGENT_SPECS } from './definitions.js';
import type { AgentSpec } from './types.js';
import { resolveCapabilities } from '../capabilities/posture-mapping.js';

describe('AgentSpec capability declarations', () => {
  it('AgentSpec_DeclaresCapabilities_NotClaudeTools', () => {
    // IMPLEMENTER must derive capability vocabulary, not Claude tool names.
    const caps = resolveCapabilities(IMPLEMENTER.posture, IMPLEMENTER.id);
    for (const cap of ['fs:read', 'fs:write', 'shell:exec', 'mcp:exarchos', 'isolation:worktree'] as const) {
      expect(caps.has(cap)).toBe(true);
    }

    // No top-level Claude-shaped `tools` field on the domain spec.
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

  it('AgentSpec_ReviewerCapabilities_ReadOnly', () => {
    const caps = resolveCapabilities(REVIEWER.posture, REVIEWER.id);
    expect(caps.has('fs:read')).toBe(true);
    expect(caps.has('mcp:exarchos:readonly')).toBe(true);
    // Reviewer is read-only: must not declare write capability. The
    // mutating-MCP trust boundary is now capability-enforced via the
    // `mcp:exarchos:readonly` tier (T03/T04) rather than prompt-enforced.
    expect(caps.has('fs:write')).toBe(false);
  });

  it('REVIEWER_Capabilities_UsesReadonlyMCP', () => {
    // T11: REVIEWER migrates from `mcp:exarchos` to `mcp:exarchos:readonly`.
    // The dispatch-layer gate (T04) only fires when the readonly tier is
    // present AND the full tier is NOT — so we must drop `mcp:exarchos`.
    const caps = resolveCapabilities(REVIEWER.posture, REVIEWER.id);
    expect(caps.has('mcp:exarchos:readonly')).toBe(true);
    expect(caps.has('mcp:exarchos')).toBe(false);
  });

  it('REVIEWER_SystemPrompt_LacksForbiddenActionsBlock', () => {
    // T11: with the dispatch-layer gate enforcing the trust boundary
    // structurally, the prose-layer "Forbidden MCP Actions" block is
    // redundant and removed.
    expect(REVIEWER.systemPrompt).not.toContain('Forbidden MCP Actions');
    expect(REVIEWER.systemPrompt).not.toContain('You MUST NOT call any other MCP action');
    expect(REVIEWER.systemPrompt).not.toContain('exarchos_event append/batch_append');
  });

  it('REVIEWER_SystemPrompt_PreservesNonForbiddenSections', () => {
    // The deletion must be scoped — other systemPrompt sections survive.
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

  // ─── C5 (#1220): isolation:worktree on write-capable specs ────────────────
  //
  // The Claude adapter only renders `isolation: worktree` frontmatter when the
  // spec declares the `'isolation:worktree'` capability (see
  // `adapters/claude.ts:135–137`). FIXER and SCAFFOLDER both have `fs:write`
  // and `shell:exec`, so they must declare `isolation:worktree` — otherwise
  // parallel dispatch corrupts the orchestrator's main worktree (#1220).
  // REVIEWER is read-only and intentionally does NOT declare it; this test
  // pins that posture so the C5 fix doesn't over-correct.

  it('FIXER_capabilities_includesIsolationWorktree', () => {
    const caps = resolveCapabilities(FIXER.posture, FIXER.id);
    expect(caps.has('isolation:worktree')).toBe(true);
  });

  it('SCAFFOLDER_capabilities_includesIsolationWorktree', () => {
    const caps = resolveCapabilities(SCAFFOLDER.posture, SCAFFOLDER.id);
    expect(caps.has('isolation:worktree')).toBe(true);
  });

  it('REVIEWER_capabilities_readOnlyDoesNotRequireIsolation', () => {
    // Pin the read-only posture: REVIEWER must not have write/shell caps,
    // and correspondingly does not need worktree isolation. This prevents
    // C5 from accidentally adding isolation everywhere.
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

  // DR-2 (T-08, #1204): IMPLEMENTER prompt must include an explicit
  // "Working Directory Setup" recovery step BEFORE the verification block.
  // Some runtimes (Copilot CLI, generic MCP) spawn subagents in the parent
  // repo cwd. Without an explicit `cd <worktree>` first, the verification
  // `pwd | grep .worktrees` fails on turn 0 and the agent aborts before
  // doing any work. The recovery step makes the prompt robust across all
  // runtime environments — basileus-forward (#1109 Constraint 3).
  it('ImplementerSpec_PromptBody_IncludesCdIntoWorktreeBeforeVerification', () => {
    const prompt = IMPLEMENTER.systemPrompt;

    // The new section header must be present.
    const wdSetupIndex = prompt.indexOf('## Working Directory Setup');
    expect(wdSetupIndex, 'IMPLEMENTER systemPrompt must include "## Working Directory Setup"').toBeGreaterThan(-1);

    // It must come BEFORE the verification block, not after.
    const verificationIndex = prompt.indexOf('## Worktree Verification');
    expect(verificationIndex).toBeGreaterThan(-1);
    expect(wdSetupIndex).toBeLessThan(verificationIndex);

    // Both bash and PowerShell entry forms must be available.
    const setupSection = prompt.slice(wdSetupIndex, verificationIndex);
    expect(setupSection).toMatch(/\bcd\b/);
    expect(setupSection).toMatch(/Set-Location/);
  });

  // #1470/#1483 (F1): post-test validation commands must be toolchain-neutral.
  // The command is the fixed runtime-resolving `exarchos run-tests`, which
  // resolves the project's test command at the CONSUMER's runtime (their cwd's
  // `.exarchos.yml` / project markers). It must NOT be a gen-time-resolved
  // literal — the shipped artifacts are static, so any baked toolchain command
  // (e.g. npm) would defeat agnosticism for non-Node consumers (INV-4).
  it('Hooks_PostTestCommand_IsRuntimeResolvingExarchosRunTests_NotBakedToolchain', () => {
    for (const spec of ALL_AGENT_SPECS) {
      const postTestRules = (spec.validationRules ?? []).filter(
        (r) => r.trigger === 'post-test' && typeof r.command === 'string',
      );
      for (const rule of postTestRules) {
        const cmd = rule.command as string;
        // Must delegate resolution to the runtime via `exarchos run-tests`.
        expect(cmd, `${spec.id} post-test command must be 'exarchos run-tests'`).toBe(
          'exarchos run-tests',
        );
        // Must NOT bake any toolchain-specific invocation (the whole point).
        expect(
          /npm |yarn |pnpm |cargo |pytest|dotnet |\{\{testCommand\}\}/.test(cmd),
          `${spec.id} post-test command must not bake a toolchain command: ${cmd}`,
        ).toBe(false);
      }
    }
  });

  // #1470 (T13): the worktree-hygiene prose in agent system prompts must be
  // toolchain-neutral — no hardcoded `npm --prefix` examples. The neutral
  // principle (`git -C <worktree>` for git ops, "run the project test command
  // from the worktree") must be present so non-Node projects (Cargo, pytest,
  // dotnet) are not implicitly assumed.
  it('WorktreeHygiene_Prose_IsToolchainNeutral_NoHardcodedNpm', () => {
    for (const spec of ALL_AGENT_SPECS) {
      const prompt = spec.systemPrompt;
      // Only the isolated agents carry the worktree-hygiene contract.
      if (!prompt.includes('Worktree Hygiene')) continue;

      expect(
        prompt.includes('npm --prefix'),
        `${spec.id} worktree-hygiene prose must not hardcode 'npm --prefix'`,
      ).toBe(false);
      expect(
        prompt.includes('npm run typecheck'),
        `${spec.id} worktree-hygiene prose must not hardcode 'npm run typecheck'`,
      ).toBe(false);

      // The toolchain-neutral principles must be present.
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
