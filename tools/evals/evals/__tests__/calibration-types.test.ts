import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fc } from '@fast-check/vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  HumanGradedCaseSchema,
  CalibrationReportSchema,
  CalibrateInputSchema,
  loadGoldStandard,
} from '../calibration-types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

let tmpDir: string;

function tmpFile(name: string): string {
  return path.join(tmpDir, name);
}

function makeValidCase(overrides?: Record<string, unknown>) {
  return {
    caseId: 'case-001',
    skill: 'brainstorming',
    rubricName: 'completeness',
    humanVerdict: true,
    humanScore: 0.9,
    humanRationale: 'Output covers all required aspects',
    ...overrides,
  };
}

function toJsonl(cases: Array<Record<string, unknown>>): string {
  return cases.map((c) => JSON.stringify(c)).join('\n');
}

// ─── Setup/Teardown ─────────────────────────────────────────────────────────

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'calibration-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ─── HumanGradedCaseSchema Unit Tests ───────────────────────────────────────

describe('HumanGradedCaseSchema', () => {
  it('HumanGradedCaseSchema_ValidCase_ParsesSuccessfully', () => {
    // Arrange
    const input = makeValidCase();

    // Act
    const result = HumanGradedCaseSchema.parse(input);

    // Assert
    expect(result.caseId).toBe('case-001');
    expect(result.skill).toBe('brainstorming');
    expect(result.rubricName).toBe('completeness');
    expect(result.humanVerdict).toBe(true);
    expect(result.humanScore).toBe(0.9);
    expect(result.humanRationale).toBe('Output covers all required aspects');
    expect(result.graderOutput).toBeUndefined();
  });

  it('HumanGradedCaseSchema_MissingSkill_ThrowsValidationError', () => {
    // Arrange
    const input = makeValidCase();
    delete (input as Record<string, unknown>).skill;

    // Act & Assert
    expect(() => HumanGradedCaseSchema.parse(input)).toThrow();
  });

  it('HumanGradedCaseSchema_ScoreOutOfRange_ThrowsValidationError', () => {
    // Arrange & Act & Assert
    expect(() =>
      HumanGradedCaseSchema.parse(makeValidCase({ humanScore: -0.1 }))
    ).toThrow();
    expect(() =>
      HumanGradedCaseSchema.parse(makeValidCase({ humanScore: 1.1 }))
    ).toThrow();
  });

  it('HumanGradedCaseSchema_WithGraderOutput_ParsesSuccessfully', () => {
    // Arrange
    const input = makeValidCase({
      graderOutput: {
        passed: true,
        score: 0.85,
        reason: 'LLM judge agrees with human',
      },
    });

    // Act
    const result = HumanGradedCaseSchema.parse(input);

    // Assert
    expect(result.graderOutput).toBeDefined();
    expect(result.graderOutput!.passed).toBe(true);
    expect(result.graderOutput!.score).toBe(0.85);
    expect(result.graderOutput!.reason).toBe('LLM judge agrees with human');
  });

  it('HumanGradedCaseSchema_MissingCaseId_ThrowsValidationError', () => {
    // Arrange
    const input = makeValidCase();
    delete (input as Record<string, unknown>).caseId;

    // Act & Assert
    expect(() => HumanGradedCaseSchema.parse(input)).toThrow();
  });

  it('HumanGradedCaseSchema_EmptyCaseId_ThrowsValidationError', () => {
    // Act & Assert
    expect(() =>
      HumanGradedCaseSchema.parse(makeValidCase({ caseId: '' }))
    ).toThrow();
  });

  it('HumanGradedCaseSchema_EmptySkill_ThrowsValidationError', () => {
    // Act & Assert
    expect(() =>
      HumanGradedCaseSchema.parse(makeValidCase({ skill: '' }))
    ).toThrow();
  });

  it('HumanGradedCaseSchema_EmptyRubricName_ThrowsValidationError', () => {
    // Act & Assert
    expect(() =>
      HumanGradedCaseSchema.parse(makeValidCase({ rubricName: '' }))
    ).toThrow();
  });

  it('HumanGradedCaseSchema_ScoreBoundaries_ParsesSuccessfully', () => {
    // Score of exactly 0 should pass
    expect(() =>
      HumanGradedCaseSchema.parse(makeValidCase({ humanScore: 0 }))
    ).not.toThrow();

    // Score of exactly 1 should pass
    expect(() =>
      HumanGradedCaseSchema.parse(makeValidCase({ humanScore: 1 }))
    ).not.toThrow();
  });
});

// ─── CalibrationReportSchema Unit Tests ─────────────────────────────────────

describe('CalibrationReportSchema', () => {
  it('CalibrationReportSchema_ValidReport_ParsesSuccessfully', () => {
    // Arrange
    const input = {
      skill: 'brainstorming',
      rubricName: 'completeness',
      split: 'validation',
      totalCases: 10,
      truePositives: 5,
      trueNegatives: 3,
      falsePositives: 1,
      falseNegatives: 1,
      tpr: 0.833,
      tnr: 0.75,
      accuracy: 0.8,
      f1: 0.833,
      disagreements: [],
    };

    // Act
    const result = CalibrationReportSchema.parse(input);

    // Assert
    expect(result.skill).toBe('brainstorming');
    expect(result.split).toBe('validation');
    expect(result.totalCases).toBe(10);
  });

  it('CalibrationReportSchema_InvalidSplit_ThrowsValidationError', () => {
    // Act & Assert
    expect(() =>
      CalibrationReportSchema.parse({
        skill: 'brainstorming',
        rubricName: 'completeness',
        split: 'train',
        totalCases: 0,
        truePositives: 0,
        trueNegatives: 0,
        falsePositives: 0,
        falseNegatives: 0,
        tpr: 0,
        tnr: 0,
        accuracy: 0,
        f1: 0,
        disagreements: [],
      })
    ).toThrow();
  });

  it('CalibrationReportSchema_WithDisagreements_ParsesSuccessfully', () => {
    // Arrange
    const input = {
      skill: 'debug',
      rubricName: 'root-cause',
      split: 'test',
      totalCases: 5,
      truePositives: 2,
      trueNegatives: 1,
      falsePositives: 1,
      falseNegatives: 1,
      tpr: 0.667,
      tnr: 0.5,
      accuracy: 0.6,
      f1: 0.667,
      disagreements: [
        {
          caseId: 'case-003',
          humanVerdict: true,
          judgeVerdict: false,
          humanRationale: 'Human says pass',
          judgeReason: 'Judge says fail',
        },
      ],
    };

    // Act
    const result = CalibrationReportSchema.parse(input);

    // Assert
    expect(result.disagreements).toHaveLength(1);
    expect(result.disagreements[0].caseId).toBe('case-003');
  });
});

// ─── CalibrateInputSchema Unit Tests ────────────────────────────────────────

describe('CalibrateInputSchema', () => {
  it('CalibrateInputSchema_ValidInput_ParsesSuccessfully', () => {
    // Arrange
    const input = {
      goldStandardPath: '/path/to/gold.jsonl',
      split: 'validation',
    };

    // Act
    const result = CalibrateInputSchema.parse(input);

    // Assert
    expect(result.goldStandardPath).toBe('/path/to/gold.jsonl');
    expect(result.split).toBe('validation');
    expect(result.skill).toBeUndefined();
  });

  it('CalibrateInputSchema_WithOptionalSkill_ParsesSuccessfully', () => {
    // Arrange
    const input = {
      goldStandardPath: '/path/to/gold.jsonl',
      split: 'test',
      skill: 'brainstorming',
    };

    // Act
    const result = CalibrateInputSchema.parse(input);

    // Assert
    expect(result.skill).toBe('brainstorming');
  });

  it('CalibrateInputSchema_InvalidSplit_ThrowsValidationError', () => {
    // Act & Assert
    expect(() =>
      CalibrateInputSchema.parse({
        goldStandardPath: '/path/to/gold.jsonl',
        split: 'train',
      })
    ).toThrow();
  });
});

// ─── loadGoldStandard Unit Tests ────────────────────────────────────────────

describe('loadGoldStandard', () => {
  it('LoadGoldStandard_ValidJSONL_ReturnsTypedArray', async () => {
    // Arrange
    const cases = [
      makeValidCase({ caseId: 'c-1' }),
      makeValidCase({ caseId: 'c-2', humanVerdict: false, humanScore: 0.1 }),
    ];
    await fs.writeFile(tmpFile('gold.jsonl'), toJsonl(cases));

    // Act
    const result = await loadGoldStandard(tmpFile('gold.jsonl'));

    // Assert
    expect(result).toHaveLength(2);
    expect(result[0].caseId).toBe('c-1');
    expect(result[1].caseId).toBe('c-2');
    expect(result[1].humanVerdict).toBe(false);
    expect(result[1].humanScore).toBe(0.1);
  });

  it('LoadGoldStandard_EmptyFile_ReturnsEmptyArray', async () => {
    // Arrange
    await fs.writeFile(tmpFile('empty.jsonl'), '');

    // Act
    const result = await loadGoldStandard(tmpFile('empty.jsonl'));

    // Assert
    expect(result).toEqual([]);
  });

  it('LoadGoldStandard_InvalidLine_ThrowsWithLineNumber', async () => {
    // Arrange
    const lines = [
      JSON.stringify(makeValidCase({ caseId: 'c-1' })),
      '{ this is not valid json }',
    ];
    await fs.writeFile(tmpFile('bad.jsonl'), lines.join('\n'));

    // Act & Assert
    await expect(loadGoldStandard(tmpFile('bad.jsonl'))).rejects.toThrow(/line 2/i);
  });

  it('LoadGoldStandard_SchemaViolation_ThrowsWithLineNumber', async () => {
    // Arrange — missing required 'skill' field
    const lines = [
      JSON.stringify({
        caseId: 'c-1',
        rubricName: 'test',
        humanVerdict: true,
        humanScore: 0.5,
        humanRationale: 'reason',
      }),
    ];
    await fs.writeFile(tmpFile('schema-bad.jsonl'), lines.join('\n'));

    // Act & Assert
    await expect(loadGoldStandard(tmpFile('schema-bad.jsonl'))).rejects.toThrow(/line 1/i);
  });

  it('LoadGoldStandard_BlankLines_SkipsGracefully', async () => {
    // Arrange
    const case1 = JSON.stringify(makeValidCase({ caseId: 'c-1' }));
    const case2 = JSON.stringify(makeValidCase({ caseId: 'c-2' }));
    const content = `${case1}\n\n   \n${case2}\n\n`;
    await fs.writeFile(tmpFile('blanks.jsonl'), content);

    // Act
    const result = await loadGoldStandard(tmpFile('blanks.jsonl'));

    // Assert
    expect(result).toHaveLength(2);
    expect(result[0].caseId).toBe('c-1');
    expect(result[1].caseId).toBe('c-2');
  });

  it('LoadGoldStandard_FileNotFound_ThrowsError', async () => {
    // Act & Assert
    await expect(loadGoldStandard(tmpFile('nonexistent.jsonl'))).rejects.toThrow();
  });
});

// ─── Property Tests ─────────────────────────────────────────────────────────

describe('HumanGradedCase Property Tests', () => {
  const validCaseArb = fc.record({
    caseId: fc.string({ minLength: 1 }),
    skill: fc.string({ minLength: 1 }),
    rubricName: fc.string({ minLength: 1 }),
    humanVerdict: fc.boolean(),
    humanScore: fc.double({ min: 0, max: 1, noNaN: true }),
    humanRationale: fc.string({ minLength: 1 }),
  });

  it('SchemaCompliance_ValidHumanGradedCase_ParsesWithoutError', () => {
    fc.assert(
      fc.property(validCaseArb, (data) => {
        expect(() => HumanGradedCaseSchema.parse(data)).not.toThrow();
      }),
    );
  });

  it('Rejection_MissingRequiredFields_IsRejected', () => {
    const requiredFields = [
      'caseId',
      'skill',
      'rubricName',
      'humanVerdict',
      'humanScore',
      'humanRationale',
    ] as const;

    fc.assert(
      fc.property(
        validCaseArb,
        fc.constantFrom(...requiredFields),
        (data, fieldToRemove) => {
          const modified = { ...data };
          delete (modified as Record<string, unknown>)[fieldToRemove];
          expect(() => HumanGradedCaseSchema.parse(modified)).toThrow();
        },
      ),
    );
  });

  it('Rejection_OutOfRangeScore_IsRejected', () => {
    const outOfRangeScore = fc.oneof(
      fc.double({ min: 1.001, max: 100, noNaN: true }),
      fc.double({ min: -100, max: -0.001, noNaN: true }),
    );

    fc.assert(
      fc.property(validCaseArb, outOfRangeScore, (data, badScore) => {
        const modified = { ...data, humanScore: badScore };
        expect(() => HumanGradedCaseSchema.parse(modified)).toThrow();
      }),
    );
  });

  it('Roundtrip_ParsedOutputReparses', () => {
    fc.assert(
      fc.property(validCaseArb, (data) => {
        const parsed = HumanGradedCaseSchema.parse(data);
        expect(() => HumanGradedCaseSchema.parse(parsed)).not.toThrow();
      }),
    );
  });

  it('Roundtrip_SerializedAndLoaded_EqualsOriginal', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(validCaseArb, { minLength: 1, maxLength: 5 }),
        async (cases) => {
          const filePath = tmpFile(`roundtrip-${Date.now()}-${Math.random()}.jsonl`);
          const jsonl = cases.map((c) => JSON.stringify(c)).join('\n');
          await fs.writeFile(filePath, jsonl);

          const loaded = await loadGoldStandard(filePath);

          expect(loaded).toHaveLength(cases.length);
          for (let i = 0; i < cases.length; i++) {
            expect(loaded[i].caseId).toBe(cases[i].caseId);
            expect(loaded[i].skill).toBe(cases[i].skill);
            expect(loaded[i].rubricName).toBe(cases[i].rubricName);
            expect(loaded[i].humanVerdict).toBe(cases[i].humanVerdict);
            expect(loaded[i].humanScore).toBe(cases[i].humanScore);
            expect(loaded[i].humanRationale).toBe(cases[i].humanRationale);
          }
        },
      ),
      { numRuns: 20 },
    );
  });
});
