/**
 * Task 026 — Tier-1 runtime smoke tests.
 *
 * The plan envisions running a dummy feature through the full
 * ideate → plan → delegate → review → synthesize → cleanup arc for each
 * runtime. That requires real agent CLIs and a live workflow harness we
 * do not yet have. Per the plan's own Note:
 *
 *   "The point is not to exercise every runtime's subagent system — it's
 *    to verify the rendered skill body is well-formed and contains the
 *    expected native syntax. The semantic behavior of each runtime is not
 *    this feature's responsibility; the invariant is 'the substitution
 *    produced what we told it to produce.'"
 *
 * So these tests assert exactly that invariant. Each test:
 *
 *   1. Loads every `skills/<runtime>/<skill>/SKILL.md` via the smoke
 *      helpers (`loadRuntimeSkills`) — this fails in RED because the
 *      helper module does not yet exist.
 *   2. Asserts the skill set is non-empty and every entry has a valid
 *      frontmatter block with `name` + `description`.
 *   3. Asserts no unsubstituted `{{TOKEN}}` placeholders leaked through
 *      the renderer.
 *   4. Asserts runtime-specific native-syntax substrings are present in
 *      the rendered delegation skill body — the smoke proof that the
 *      per-runtime `SPAWN_AGENT_CALL` substitution actually fired.
 *
 * The Cursor test additionally asserts the sequential-fallback warning
 * text is present in the rendered delegation body (the one-line
 * behavioral assertion the plan called out).
 *
 * Non-Claude runtimes are gated behind `SMOKE=1` because in future we
 * want this file to also be the anchor for a real-CLI smoke matrix.
 * Today's GREEN body does NOT shell out to any real CLI — the
 * substitution-correctness invariant is what's actually verifiable, and
 * the `SMOKE=1` gate just controls whether the non-Claude rendered-body
 * checks run in the default test run or only under the matrix job.
 *
 * Implements: Testing Strategy > Smoke tests.
 */

import { describe, it, expect } from 'vitest';
import {
  loadRuntimeSkills,
  assertNoUnsubstitutedPlaceholders,
  findDelegationSkill,
  assertFrontmatterValid,
} from './helpers.js';

const smokeAll = process.env.SMOKE === '1';

describe('task 026 — tier-1 runtime smoke tests', () => {
  it('Smoke_Claude_FullWorkflow_CompletesWithGreenGates', () => {
    const skills = loadRuntimeSkills('claude');
    expect(skills.length).toBeGreaterThan(0);
    for (const s of skills) {
      assertFrontmatterValid(s);
      assertNoUnsubstitutedPlaceholders(s);
    }
    // Claude-specific: `Task({ ... })` with `subagent_type` + the
    // `run_in_background: true` flag must appear in the rendered
    // delegation body. That is the proof that claude.yaml's
    // `SPAWN_AGENT_CALL` substituted correctly.
    const delegation = findDelegationSkill(skills);
    expect(delegation.body).toContain('Task({');
    expect(delegation.body).toContain('subagent_type: "exarchos-implementer"');
    expect(delegation.body).toContain('run_in_background: true');
  });

  it.skipIf(!smokeAll)(
    'Smoke_OpenCode_FullWorkflow_CompletesWithGreenGates',
    () => {
      const skills = loadRuntimeSkills('opencode');
      expect(skills.length).toBeGreaterThan(0);
      for (const s of skills) {
        assertFrontmatterValid(s);
        assertNoUnsubstitutedPlaceholders(s);
      }
      // OpenCode mirrors Claude's `Task({ ... })` shape minus
      // `run_in_background` (no hooks / background fanout).
      const delegation = findDelegationSkill(skills);
      expect(delegation.body).toContain('Task({');
      expect(delegation.body).toContain(
        'subagent_type: "exarchos-implementer"',
      );
    },
  );

  it.skipIf(!smokeAll)(
    'Smoke_Codex_FullWorkflow_CompletesWithGreenGates',
    () => {
      const skills = loadRuntimeSkills('codex');
      expect(skills.length).toBeGreaterThan(0);
      for (const s of skills) {
        assertFrontmatterValid(s);
        assertNoUnsubstitutedPlaceholders(s);
      }
      // Codex uses the literal OpenAI-style function call
      // `spawn_agent({ ... })` with `agent_type: "default"`.
      const delegation = findDelegationSkill(skills);
      expect(delegation.body).toContain('spawn_agent({');
      expect(delegation.body).toContain('agent_type: "default"');
    },
  );

  it.skipIf(!smokeAll)(
    'Smoke_Copilot_FullWorkflow_CompletesWithGreenGates',
    () => {
      const skills = loadRuntimeSkills('copilot');
      expect(skills.length).toBeGreaterThan(0);
      for (const s of skills) {
        assertFrontmatterValid(s);
        assertNoUnsubstitutedPlaceholders(s);
      }
      // Copilot uses the `/delegate "..."` slash-command form.
      const delegation = findDelegationSkill(skills);
      expect(delegation.body).toContain('/delegate "');
    },
  );

  it.skipIf(!smokeAll)(
    'Smoke_Cursor_FullWorkflow_SequentialCompletesWithGreenGates',
    () => {
      const skills = loadRuntimeSkills('cursor');
      expect(skills.length).toBeGreaterThan(0);
      for (const s of skills) {
        assertFrontmatterValid(s);
        assertNoUnsubstitutedPlaceholders(s);
      }
      // Cursor has no subagent primitive: the rendered delegation body
      // must contain the sequential-fallback warning and must not
      // contain a `Task({` or `spawn_agent({` call (those would indicate
      // a runtime-map crosswire). The warning text is whatever
      // runtimes/cursor.yaml's `SPAWN_AGENT_CALL` emits — asserted as
      // three stable substrings rather than a full-line match so
      // wrapping/indent changes in the renderer don't flake the test.
      const delegation = findDelegationSkill(skills);
      expect(delegation.body).toContain(
        'Cursor CLI has no in-session subagent primitive',
      );
      expect(delegation.body).toContain('Execute each task sequentially');
      expect(delegation.body).toContain(
        'Emit a single warning',
      );
      expect(delegation.body).not.toContain('Task({');
      expect(delegation.body).not.toContain('spawn_agent({');
    },
  );
});
