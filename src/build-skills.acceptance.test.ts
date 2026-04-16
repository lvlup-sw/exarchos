/**
 * Acceptance test for the {{CALL}} macro — facade-appropriate rendering.
 *
 * Verifies that `render()` with a `runtime` parameter correctly expands
 * CALL macros into facade-appropriate output for both MCP and CLI runtimes.
 *
 * Test: RenderSkill_CallMacroWithTwoRuntimes_ProducesFacadeAppropriateInvocations
 *
 * Implements: Task 004 (acceptance layer for the dual-facade skill rendering epic)
 * GREEN as of: Task 009 (renderCallMacros wired into render + CLI branch)
 */

import { describe, it, expect } from 'vitest';
import { render } from './build-skills.js';
import { loadRuntime } from './runtimes/load.js';
import type { RuntimeMap } from './runtimes/types.js';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_RUNTIMES_DIR = resolve(__dirname, '..', 'runtimes');

/**
 * Fixture: a skill source body containing a single {{CALL}} macro invocation.
 * The macro specifies the tool name, action, and a JSON argument payload.
 */
const CALL_MACRO_SOURCE =
  '{{CALL exarchos_workflow set {"featureId":"X","phase":"plan"}}}';

describe('RenderSkill_CallMacroWithTwoRuntimes_ProducesFacadeAppropriateInvocations', () => {
  it('MCP facade (claude runtime) — produces MCP tool_use invocation', () => {
    // Load the real claude runtime — preferredFacade: "mcp"
    const claudeRuntime: RuntimeMap = loadRuntime(
      join(REPO_RUNTIMES_DIR, 'claude.yaml'),
    );
    expect(claudeRuntime.preferredFacade).toBe('mcp');

    // Render the {{CALL}} macro source under the MCP-preferred runtime.
    // render() with runtime pre-processes CALL macros via renderCallMacros().
    const rendered = render(CALL_MACRO_SOURCE, claudeRuntime.placeholders, {
      sourcePath: 'skills-src/test-skill/SKILL.md',
      runtimeName: claudeRuntime.name,
      runtime: claudeRuntime,
    });

    // The output must contain the fully-qualified MCP tool name with the
    // plugin prefix from claude.yaml's mcpPrefix.
    expect(rendered).toContain(
      'mcp__plugin_exarchos_exarchos__exarchos_workflow',
    );

    // The output must include the action and JSON arguments in the MCP
    // tool_use structure.
    expect(rendered).toContain('"featureId"');
    expect(rendered).toContain('"phase"');
  });

  it('CLI facade (generic runtime) — produces Bash CLI invocation', () => {
    // Load the real generic runtime — preferredFacade: "cli"
    const genericRuntime: RuntimeMap = loadRuntime(
      join(REPO_RUNTIMES_DIR, 'generic.yaml'),
    );
    expect(genericRuntime.preferredFacade).toBe('cli');

    // Render the {{CALL}} macro source under the CLI-preferred runtime.
    // render() with runtime pre-processes CALL macros via renderCallMacros().
    const rendered = render(CALL_MACRO_SOURCE, genericRuntime.placeholders, {
      sourcePath: 'skills-src/test-skill/SKILL.md',
      runtimeName: genericRuntime.name,
      runtime: genericRuntime,
    });

    // The output must contain a Bash-style CLI invocation with the tool
    // name, action, and camelCase-to-kebab-case converted flags.
    expect(rendered).toContain(
      'Bash(exarchos workflow set --feature-id X --phase plan --json)',
    );
  });
});
