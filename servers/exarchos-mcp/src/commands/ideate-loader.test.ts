import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInvariants } from '../architecture/invariants-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const IDEATE_COMMAND = path.join(REPO_ROOT, 'commands/ideate.md');
const BRAINSTORMING_SKILL = path.join(
  REPO_ROOT,
  'skills-src/brainstorming/SKILL.md',
);
const INVARIANTS_DOC = path.join(REPO_ROOT, 'docs/architecture/invariants.md');

describe('ideate first-turn invariant surfacing (#1260)', () => {
  it('Ideate_FirstTurn_LoadsInvariantsDoc', () => {
    const ideate = fs.readFileSync(IDEATE_COMMAND, 'utf8');
    const skill = fs.readFileSync(BRAINSTORMING_SKILL, 'utf8');

    // The /ideate command itself must reference docs/architecture/invariants.md
    // so the agent knows to consult the invariants catalog on first turn.
    expect(ideate).toContain('docs/architecture/invariants.md');

    // The brainstorming skill body must guide surfacing of relevant invariants
    // (and reference the invariants doc explicitly).
    expect(skill).toContain('docs/architecture/invariants.md');
    expect(skill.toLowerCase()).toContain('constraint anchoring');
  });

  it('Ideate_FirstTurn_SurfacesRelevantInvariants', () => {
    // The contract: for a CLI-design proposal, the surfaced section should
    // include the invariants that govern CLI / agent-first surface design —
    // INV-5a (input ergonomics), INV-5c (Aspire verbs), DIM-1 (topology).
    //
    // Modeled as: those IDs must be declared in the invariants catalog AND
    // they must be the IDs the /ideate workflow points the agent at for
    // CLI-shaped proposals. We assert (a) the catalog has them, and (b) the
    // brainstorming skill prose names them as canonical anchors so a CLI
    // proposal is guaranteed to surface them.
    //
    // Pass an explicit `enabled` config so the gating check (Wave B2)
    // doesn't short-circuit on the contents assertion. Wave B3 declares
    // the flag in the root `.exarchos.yml`; this constant keeps the test
    // stable independent of that landing order.
    const entries = loadInvariants(INVARIANTS_DOC, undefined, {
      invariants: { devCatalog: 'enabled' as const },
    });
    const ids = new Set(entries.map((e) => e.id));
    expect(ids.has('INV-5a')).toBe(true);
    expect(ids.has('INV-5c')).toBe(true);
    expect(ids.has('DIM-1')).toBe(true);

    const skill = fs.readFileSync(BRAINSTORMING_SKILL, 'utf8');
    // Skill must enumerate at least INV-5a, INV-5c, DIM-1 as CLI-design anchors.
    expect(skill).toMatch(/INV-5a/);
    expect(skill).toMatch(/INV-5c/);
    expect(skill).toMatch(/DIM-1/);
  });
});
