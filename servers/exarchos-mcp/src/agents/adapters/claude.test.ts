// ─── Claude adapter contract tests ──────────────────────────────────────────
//
// Asserts the Claude `RuntimeAdapter` implementation conforms to the port
// defined in `./types.ts`. Byte-level output regression is enforced separately
// by the snapshot suite in `generate-agents.test.ts` (pinned to the committed
// `agents/*.md` fixtures), which is the canonical contract Claude users
// depend on.
// See docs/designs/2026-04-25-delegation-runtime-parity.md §4.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { claudeAdapter } from './claude.js';
import {
  IMPLEMENTER,
  FIXER,
  REVIEWER,
  SCAFFOLDER,
} from '../definitions.js';

describe('Claude adapter', () => {
  it('ClaudeAdapter_RuntimeIdentifier_IsClaude', () => {
    expect(claudeAdapter.runtime).toBe('claude');
  });

  it('ClaudeAdapter_AgentFilePath_ReturnsAgentsPath', () => {
    expect(claudeAdapter.agentFilePath('implementer')).toBe(
      'agents/implementer.md',
    );
  });

  it('ClaudeAdapter_LowerImplementer_ProducesNonEmptyMarkdownWithFrontmatter', () => {
    const out = claudeAdapter.lowerSpec(IMPLEMENTER);
    expect(out.contents.length).toBeGreaterThan(0);
    expect(out.contents.startsWith('---\n')).toBe(true);
    expect(out.contents).toContain('name: exarchos-implementer');
    expect(out.contents).toMatch(/tools:\s*\[/);
    // Body should include some implementer description text.
    expect(out.contents).toContain('TDD');
  });

  it('ClaudeAdapter_LowerAllFourSpecs_AllProduceValidOutput', () => {
    for (const spec of [IMPLEMENTER, FIXER, REVIEWER, SCAFFOLDER]) {
      const out = claudeAdapter.lowerSpec(spec);
      expect(out.path).toBe(`agents/${spec.id}.md`);
      expect(out.contents.length).toBeGreaterThan(0);
      expect(out.contents.startsWith('---\n')).toBe(true);
    }
  });

  it('ClaudeAdapter_ValidateSupport_AllSpecsSucceed', () => {
    for (const spec of [IMPLEMENTER, FIXER, REVIEWER, SCAFFOLDER]) {
      expect(claudeAdapter.validateSupport(spec)).toEqual({ ok: true });
    }
  });
});
