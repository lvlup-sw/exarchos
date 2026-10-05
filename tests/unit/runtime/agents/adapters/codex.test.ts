/**
 * Contract tests for the Codex `RuntimeAdapter`. Codex reads custom agents from `.codex/agents/<name>.toml`.
 * The file requires `name`, `description` and `developer_instructions`.
 * `customAgentResolutionWorks` is `false`, because openai/codex#15250 and openai/codex#14579 make dispatch by agent name unreliable.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { AgentSpec } from '../../../../../src/runtime/agents/types.js';
import type { Capability } from '../../../../../src/runtime/agents/capabilities.js';
import { codexAdapter, tomlBasicString } from '../../../../../src/runtime/agents/adapters/codex.js';
import { REVIEWER, IMPLEMENTER } from '../../../../../src/runtime/agents/definitions.js';
import * as PostureMapping from '../../../../../src/workflow/capabilities/posture-mapping.js';

/**
 * `AgentSpec` has no `capabilities` field. `resolveCapabilities` derives the capabilities from `posture` and `id`.
 * A test that needs a specific capability set mocks the resolver with `forceCapabilities`.
 */
const baseSpec: AgentSpec = {
  id: 'implementer',
  description: 'TDD implementer that writes failing tests then code.',
  systemPrompt: 'You are a TDD implementer agent. Follow Red-Green-Refactor.',
  posture: 'task-isolated',
  model: 'inherit',
  skills: [],
  validationRules: [],
  resumable: false,
};

function forceCapabilities(caps: readonly Capability[]): void {
  vi.spyOn(PostureMapping, 'resolveCapabilities').mockReturnValue(
    Object.freeze(new Set<Capability>(caps)),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CodexAdapter', () => {
  it('CodexAdapter_RuntimeIdentifier_IsCodex', () => {
    expect(codexAdapter.runtime).toBe('codex');
  });

  it('CodexAdapter_AgentFilePath_ReturnsCodexAgentsPath', () => {
    expect(codexAdapter.agentFilePath('implementer')).toBe(
      '.codex/agents/implementer.toml',
    );
  });

  it('CodexAdapter_LowerImplementer_EmitsValidTOML', () => {
    const { path, contents } = codexAdapter.lowerSpec(baseSpec);

    expect(path).toBe('.codex/agents/implementer.toml');

    expect(contents).toMatch(/^name\s*=\s*"implementer"\s*$/m);
    expect(contents).toMatch(/^description\s*=\s*".+"\s*$/m);
    expect(contents).toMatch(/^developer_instructions\s*=\s*"""/m);
  });

  it('CodexAdapter_DeveloperInstructions_IncludesSpecBodyAndCapabilityDescriptions', () => {
    const { contents } = codexAdapter.lowerSpec(baseSpec);

    expect(contents).toContain('Red-Green-Refactor');
    expect(contents).toContain('fs:read');
    expect(contents).toContain('fs:write');
    expect(contents).toContain('shell:exec');
    expect(contents).toContain('mcp:exarchos');
    expect(contents).toContain('isolation:worktree');
  });

  it('CodexAdapter_ValidateSupport_RejectsClaudeOnlyCapabilities', () => {
    forceCapabilities(['fs:read', 'team:agent-teams']);
    const result = codexAdapter.validateSupport(baseSpec);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('team:agent-teams');
      expect(result.fixHint.length).toBeGreaterThan(0);
    }
  });

  it('CodexAdapter_FallbackFlag_DefaultsToFalse', () => {
    expect(codexAdapter.customAgentResolutionWorks).toBe(false);
  });

  /**
   * The readonly tier must lower to the same `mcp_servers = ["exarchos"]` line as `mcp:exarchos`.
   * Without the line, an agent with only the readonly tier cannot call the read-only actions.
   * The dispatch layer limits the tier per action.
   */
  it('CodexAdapter_LowerSpec_Readonly_GrantsExarchosTool', () => {
    forceCapabilities(['fs:read', 'mcp:exarchos:readonly', 'isolation:worktree']);
    const readonlySpec: AgentSpec = {
      ...baseSpec,
      mcpServers: undefined,
    };
    const { contents } = codexAdapter.lowerSpec(readonlySpec);

    expect(contents).toMatch(/^mcp_servers\s*=\s*\["exarchos"\]\s*$/m);
  });

  /** The `task-isolated` posture of `baseSpec` resolves to `mcp:exarchos`, which gives the same `mcp_servers` line. */
  it('CodexAdapter_LowerSpec_FullCap_BehaviorUnchanged', () => {
    const fullSpec: AgentSpec = {
      ...baseSpec,
      mcpServers: undefined,
    };
    const { contents } = codexAdapter.lowerSpec(fullSpec);
    expect(contents).toMatch(/^mcp_servers\s*=\s*\["exarchos"\]\s*$/m);
  });

  /** The support level of the readonly tier is not `unsupported`, so a spec with that tier passes validation. */
  it('CodexAdapter_ValidateSupport_AcceptsReadonlyCapability', () => {
    forceCapabilities(['fs:read', 'mcp:exarchos:readonly']);
    const result = codexAdapter.validateSupport(baseSpec);
    expect(result.ok).toBe(true);
  });

  /**
   * `sandbox_mode` is the structural gate of Codex for file and shell access.
   * Without `fs:write` and `shell:exec`, the mode is `read-only`. With either capability, the mode is `workspace-write`.
   * The reviewer resolves to neither capability.
   */
  it('CodexAdapter_LowerSpec_OmitsWriteAccess_WhenSpecLacksFsWrite', () => {
    const { contents } = codexAdapter.lowerSpec(REVIEWER);
    expect(contents).toMatch(/^sandbox_mode\s*=\s*"read-only"\s*$/m);
    expect(contents).not.toMatch(/^sandbox_mode\s*=\s*"workspace-write"\s*$/m);
  });

  /** The capabilities of the implementer include `fs:write` and `shell:exec`. */
  it('CodexAdapter_LowerSpec_IncludesWriteAccess_WhenSpecHasFsWrite', () => {
    const { contents } = codexAdapter.lowerSpec(IMPLEMENTER);
    expect(contents).toMatch(/^sandbox_mode\s*=\s*"workspace-write"\s*$/m);
    expect(contents).not.toMatch(/^sandbox_mode\s*=\s*"read-only"\s*$/m);
  });

  /** The `sandbox_mode` lines must differ. Thus the read-only contract of the reviewer is in the rendered file, and not only in the prompt text. */
  it('CodexAdapter_LowerSpec_REVIEWER_AND_IMPLEMENTER_HaveDistinctToolSurfaces', () => {
    const r = codexAdapter.lowerSpec(REVIEWER);
    const i = codexAdapter.lowerSpec(IMPLEMENTER);
    const reviewerSandbox = r.contents.match(/^sandbox_mode\s*=\s*"([^"]+)"\s*$/m);
    const implementerSandbox = i.contents.match(/^sandbox_mode\s*=\s*"([^"]+)"\s*$/m);
    expect(reviewerSandbox?.[1]).toBe('read-only');
    expect(implementerSandbox?.[1]).toBe('workspace-write');
    expect(r.contents).not.toEqual(i.contents);
  });

  /**
   * The test reads the committed `.codex/agents/*.toml` files, to catch drift between the adapter output and the files that ship.
   * A stale render or a hand edit can leave a wrong `sandbox_mode` in a committed file while the `lowerSpec` tests pass.
   * The repo root is five directories up from this test file.
   */
  it('CodexArtifact_OnDisk_REVIEWER_AND_IMPLEMENTER_HaveDistinctToolSurfaces', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(here, '../../../../..');
    const reviewerToml = readFileSync(
      resolve(repoRoot, '.codex/agents/reviewer.toml'),
      'utf8',
    );
    const implementerToml = readFileSync(
      resolve(repoRoot, '.codex/agents/implementer.toml'),
      'utf8',
    );

    expect(reviewerToml).toMatch(/^sandbox_mode\s*=\s*"read-only"\s*$/m);
    expect(implementerToml).toMatch(
      /^sandbox_mode\s*=\s*"workspace-write"\s*$/m,
    );
    expect(reviewerToml).not.toBe(implementerToml);
  });
});

/** The Codex render path must call `resolveCapabilities(spec.posture, spec.id)`. */
describe('CodexAdapter capability rendering routes through resolver (#1333 β-04)', () => {
  it('CodexAdapter_RenderAgentSpec_CallsResolveCapabilitiesNotSpecField', () => {
    const spy = vi.spyOn(PostureMapping, 'resolveCapabilities');
    codexAdapter.lowerSpec(IMPLEMENTER);
    expect(spy).toHaveBeenCalled();
    const calledWithSpecPair = spy.mock.calls.some(
      (args) => args[0] === IMPLEMENTER.posture && args[1] === IMPLEMENTER.id,
    );
    expect(calledWithSpecPair).toBe(true);
  });
});

describe('tomlBasicString', () => {
  it('TomlBasicString_EscapesBackspace', () => {
    expect(tomlBasicString('a\bb')).toBe('"a\\bb"');
  });

  it('TomlBasicString_EscapesFormfeed', () => {
    expect(tomlBasicString('a\fb')).toBe('"a\\fb"');
  });

  /** One input holds each character that the function escapes, to catch a double escape. */
  it('TomlBasicString_EscapesAllControlChars_InOrder', () => {
    const input = 'q"\\\b\f\n\r\tx';
    const got = tomlBasicString(input);
    expect(got).toBe('"q\\"\\\\\\b\\f\\n\\r\\tx"');
  });
});
