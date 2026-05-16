// ─── Sidecar Schemas — RED tests (T14, #1298) ────────────────────────────────
//
// These tests anchor the design.v1 and plan.v1 sidecar contracts. Gates
// consume the parsed sidecar instead of regex-scraping the markdown when
// the sidecar is present (see T15).
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
<<<<<<< HEAD
  AcceptanceCriterionSchema,
=======
>>>>>>> origin/main
  DesignSidecarV1,
  PlanSidecarV1,
} from './sidecar-schemas.js';

describe('SidecarSchema_DesignV1', () => {
  it('AcceptsConformantDoc', () => {
    const doc = {
      schema: 'design.v1',
      sections: {
        problem: { present: true },
        approaches: { present: true },
      },
      drs: [
        { id: 'DR-1', title: 'Zod unions', section: 'Wave A' },
        { id: 'DR-2', title: 'Quality hint', section: 'Wave A' },
      ],
      acceptance: [
        { id: 'A-1', references: ['DR-1'] },
        { id: 'A-2', references: ['DR-1', 'DR-2'] },
      ],
      options: { count: 3 },
    };

    const parsed = DesignSidecarV1.safeParse(doc);
    expect(parsed.success).toBe(true);
  });
});

describe('SidecarSchema_PlanV1', () => {
  it('AcceptsConformantDoc', () => {
    const doc = {
      schema: 'plan.v1',
      tasks: [
        { id: 'T01', phase: 'RED', description: 'Author the failing test', files: ['a.test.ts'] },
        { id: 'T02', phase: 'GREEN', description: 'Implement minimal pass', files: ['a.ts'] },
        { id: 'T03', phase: 'REFACTOR', description: 'Tidy', files: ['a.ts'] },
      ],
      coverage: {
        'DR-1': ['T01', 'T02'],
        'DR-2': ['T03'],
      },
      provenance: [
        { taskId: 'T01', dr: 'DR-1' },
        { taskId: 'T02', dr: 'DR-1' },
        { taskId: 'T03', dr: 'DR-2' },
      ],
    };

    const parsed = PlanSidecarV1.safeParse(doc);
    expect(parsed.success).toBe(true);
  });
});

describe('SidecarSchema_MismatchedSchemaVersion', () => {
  it('Rejected for design when schema is wrong literal', () => {
    const doc = {
      schema: 'design.v2', // not the literal
      sections: {},
      drs: [],
      acceptance: [],
    };
    const parsed = DesignSidecarV1.safeParse(doc);
    expect(parsed.success).toBe(false);
  });

  it('Rejected for plan when schema is wrong literal', () => {
    const doc = {
      schema: 'plan.v0',
      tasks: [],
      coverage: {},
      provenance: [],
    };
    const parsed = PlanSidecarV1.safeParse(doc);
    expect(parsed.success).toBe(false);
  });

  it('Rejected when phase is outside the RED/GREEN/REFACTOR enum', () => {
    const doc = {
      schema: 'plan.v1',
      tasks: [{ id: 'T01', phase: 'BLUE', description: 'x', files: [] }],
      coverage: {},
      provenance: [],
    };
    const parsed = PlanSidecarV1.safeParse(doc);
    expect(parsed.success).toBe(false);
  });
});
<<<<<<< HEAD

// B4 (#1406): AcceptanceCriterionSchema must require at least one
// non-empty DR reference. Empty arrays and empty strings used to slip
// through, masking content gaps in hand-authored sidecars.
describe('SidecarSchema_AcceptanceCriterion', () => {
  it('AcceptsConformantEntry', () => {
    const parsed = AcceptanceCriterionSchema.safeParse({
      id: 'A-1',
      references: ['DR-1'],
    });
    expect(parsed.success).toBe(true);
  });

  it('EmptyReferences_Rejected', () => {
    const parsed = AcceptanceCriterionSchema.safeParse({
      id: 'A-1',
      references: [],
    });
    expect(parsed.success).toBe(false);
  });

  it('EmptyReferenceString_Rejected', () => {
    const parsed = AcceptanceCriterionSchema.safeParse({
      id: 'A-1',
      references: [''],
    });
    expect(parsed.success).toBe(false);
  });
});
=======
>>>>>>> origin/main
