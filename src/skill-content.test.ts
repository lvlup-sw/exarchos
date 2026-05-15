/**
 * Skill-content lint tests (#1360 / PR 2 / T6).
 *
 * Greps `skills-src/<name>/SKILL.md` for required sections introduced by
 * the `RESERVED_FIELD` discoverability work:
 *
 *   - `workflow-state` must document the reserved-field boundary so
 *     agents discover the rule without trial-and-error against the
 *     error envelope.
 *   - `merge-orchestrator` must cross-link the workflow-state Reserved
 *     fields anchor so callers landing on the merge skill find the
 *     immutable-phase guidance one hop away.
 *
 * Asserting on the source-of-truth `skills-src/` tree (rather than the
 * rendered `skills/<runtime>/` variants) keeps the lint stable across
 * runtime placeholder substitution.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Resolve from repo root — vitest runs with cwd at the project root.
const SKILLS_SRC = join(process.cwd(), 'skills-src');

describe('skill content lint (#1360)', () => {
  it('Skill_WorkflowState_ContainsReservedFieldsSection', () => {
    const skillPath = join(SKILLS_SRC, 'workflow-state', 'SKILL.md');
    const content = readFileSync(skillPath, 'utf8');
    expect(content).toMatch(/^## Reserved fields$/m);
  });

  it('Skill_MergeOrchestrator_CrossLinksReservedFields', () => {
    const skillPath = join(SKILLS_SRC, 'merge-orchestrator', 'SKILL.md');
    const content = readFileSync(skillPath, 'utf8');
    // Cross-link to the workflow-state Reserved fields anchor. The exact
    // form is flexible (relative path or anchor reference) — just require
    // the workflow-state SKILL plus the `reserved-fields` anchor.
    expect(content).toMatch(/workflow-state\/SKILL\.md#reserved-fields/);
  });
});
