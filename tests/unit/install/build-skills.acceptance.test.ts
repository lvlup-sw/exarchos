/**
 * Acceptance test for the `{{CALL}}` macro. `render()` with a `runtime` expands the macro
 * into the invocation form of the facade that the runtime prefers: MCP or CLI.
 */

import { describe, it, expect } from 'vitest';
import { render } from '../../../src/install/build-skills.js';
import { loadRuntime } from '../../../src/install/runtimes/load.js';
import type { RuntimeMap } from '../../../src/install/runtimes/types.js';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_RUNTIMES_DIR = resolve(__dirname, '../../../content/harness/runtimes');

/** A skill body with one `{{CALL}}` macro: a tool name, an action and a JSON argument object. */
const CALL_MACRO_SOURCE =
  '{{CALL exarchos_workflow set {"featureId":"X","phase":"plan"}}}';

describe('RenderSkill_CallMacroWithTwoRuntimes_ProducesFacadeAppropriateInvocations', () => {
  /**
   * The real claude runtime prefers MCP. The output holds the tool name with the `mcpPrefix`
   * of `claude.yaml`, and the two argument names.
   */
  it('MCP facade (claude runtime) — produces MCP tool_use invocation', () => {
    const claudeRuntime: RuntimeMap = loadRuntime(
      join(REPO_RUNTIMES_DIR, 'claude.yaml'),
    );
    expect(claudeRuntime.preferredFacade).toBe('mcp');

    const rendered = render(CALL_MACRO_SOURCE, claudeRuntime.placeholders, {
      sourcePath: 'content/test-skill/SKILL.md',
      runtimeName: claudeRuntime.name,
      runtime: claudeRuntime,
    });

    expect(rendered).toContain(
      'mcp__plugin_exarchos_exarchos__exarchos_workflow',
    );

    expect(rendered).toContain('"featureId"');
    expect(rendered).toContain('"phase"');
  });

  /**
   * The real generic runtime prefers CLI. The output is a `Bash(...)` invocation, and each
   * camelCase argument name becomes a kebab-case flag.
   */
  it('CLI facade (generic runtime) — produces Bash CLI invocation', () => {
    const genericRuntime: RuntimeMap = loadRuntime(
      join(REPO_RUNTIMES_DIR, 'generic.yaml'),
    );
    expect(genericRuntime.preferredFacade).toBe('cli');

    const rendered = render(CALL_MACRO_SOURCE, genericRuntime.placeholders, {
      sourcePath: 'content/test-skill/SKILL.md',
      runtimeName: genericRuntime.name,
      runtime: genericRuntime,
    });

    expect(rendered).toContain(
      'Bash(exarchos workflow set --feature-id X --phase plan --json)',
    );
  });
});
