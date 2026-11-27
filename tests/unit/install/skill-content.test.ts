/**
 * Lint tests for skill content, read from the `content/` source tree.
 * The rendered variants substitute runtime placeholders, so the source tree is the stable target.
 * - `checkpoint` must hold a `## Reserved fields` section, so an agent finds the reserved-field rule without a failed call.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { skillPath as resolveSkillPath } from '../../../tools/test-helpers/content-tree.js';

/** vitest runs with the repository root as the working directory. */
const SKILLS_SRC = join(process.cwd(), 'content');

describe('skill content lint (#1360)', () => {
  it('Skill_Checkpoint_ContainsReservedFieldsSection', () => {
    const skillPath = resolveSkillPath('checkpoint');
    const content = readFileSync(skillPath, 'utf8');
    expect(content).toMatch(/^## Reserved fields$/m);
  });
});
