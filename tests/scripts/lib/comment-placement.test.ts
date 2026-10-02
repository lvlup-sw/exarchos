/**
 * @fileoverview Tests for the placement classifier: one case per allowed placement and per check.
 */
import { describe, it, expect } from 'vitest';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { groupBlocks } from '../../../tools/audit/lib/comment-baseline.mjs';
import { classifyPlacements, isBanner, type EsNode } from '../../../tools/audit/lib/comment-placement.mjs';

const TEST_CALLEES = ['describe', 'it', 'test', 'beforeEach'];

/** Classify every block of `code` and return `text → placement` pairs. */
function placements(code: string): [string, string][] {
  const linter = new Linter({ configType: 'flat' });
  linter.verify(code, [{ files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } }], { filename: 'x.ts' });
  const sourceCode = linter.getSourceCode();
  if (sourceCode === null) throw new Error('no source code');
  const comments = sourceCode.getAllComments().map((c) => ({ type: String(c.type), value: c.value, range: c.range as [number, number] }));
  const blocks = groupBlocks(comments, code);
  const result = classifyPlacements({ ast: sourceCode.ast as unknown as EsNode, comments, text: code, blocks, testCallees: TEST_CALLEES });
  return blocks.map((block, i) => {
    const p = result[i]!;
    return [block.text, p.allowed ? p.kind : p.checkId];
  });
}

describe('allowed placements', () => {
  it('Placement_CommentsBeforeTheFirstStatement_AreTheHeader', () => {
    expect(placements('// @ts-check\n/**\n * About this file.\n */\n\nimport x from "x";\n')).toEqual([['About this file.', 'header']]);
  });

  it('Placement_LastHeaderBlockAttachedToADeclaration_IsADescription', () => {
    expect(placements('/** Head. */\n\n/** The answer. */\nexport const a = 42;\n')).toEqual([
      ['Head.', 'header'],
      ['The answer.', 'description'],
    ]);
  });

  it('Placement_JsdocOnModuleLevelDeclarations_IsADescription', () => {
    const code = [
      'import x from "x";',
      '/** F. */',
      'export function f() {}',
      '/** C. */',
      'class C {}',
      '/** T. */',
      'type T = string;',
      '/** I. */',
      'interface I {}',
      '/** E. */',
      'enum E { A }',
      '/** Default. */',
      'export default {};',
    ].join('\n');

    expect(placements(code).map(([, p]) => p)).toEqual(Array(6).fill('description'));
  });

  it('Placement_JsdocOnMembers_IsADescription', () => {
    const code = [
      'export const x = 1;',
      'class C {',
      '  /** P. */',
      '  private readonly p = 1;',
      '  /** M. */',
      '  m(): void {}',
      '  constructor(',
      '    /** Field. */',
      '    readonly field: string,',
      '  ) {}',
      '}',
      'interface I {',
      '  /** Sig. */',
      '  a: string;',
      '}',
      'enum E {',
      '  /** Member. */',
      '  A,',
      '}',
    ].join('\n');

    expect(placements(code).map(([, p]) => p)).toEqual(['description', 'description', 'description', 'description', 'description']);
  });

  it('Placement_JsdocOnModuleLevelLiteralElements_IsADescription', () => {
    const code = 'export const x = 1;\nexport const schema = z.object({\n  /** Id. */\n  id: z.string(),\n  list: [\n    /** First. */\n    1,\n  ],\n} as const);\n';

    expect(placements(code).map(([, p]) => p)).toEqual(['description', 'description']);
  });

  it('Placement_JsdocAboveNestedTestCalls_IsADescription', () => {
    const code = 'import { it } from "vitest";\n/** Suite. */\ndescribe("s", () => {\n  /** Setup. */\n  beforeEach(() => {});\n  /** Case. */\n  it.each([1])("c", () => {});\n});\n';

    expect(placements(code).map(([, p]) => p)).toEqual(['description', 'description', 'description']);
  });

  it('Placement_DirectiveBetweenDocAndTarget_IsTransparent', () => {
    const code = 'export const x = 1;\n/** F. */\n// eslint-disable-next-line no-console\nexport function f() {}\n';

    expect(placements(code)).toEqual([['F.', 'description']]);
  });

  it('Placement_ModuleLevelTypedef_IsADeclarationOfItsOwn', () => {
    const code = 'export const x = 1;\n/**\n * A point.\n *\n * @typedef {object} Point\n * @property {number} x The x value.\n */\n\nexport const y = 2;\n';

    expect(placements(code)).toEqual([['A point. @typedef {object} Point @property {number} x The x value.', 'description']]);
  });

  it('Placement_TypedefInsideAFunction_IsInBody', () => {
    expect(placements('export function f() {\n  /** @typedef {object} P The point. */\n  return 1;\n}\n')).toEqual([['@typedef {object} P The point.', 'in-body']]);
  });

  it('Placement_DeclareModuleMember_CountsAsModuleLevel', () => {
    const code = 'export const x = 1;\ndeclare module "m" {\n  /** F. */\n  export function f(): void;\n}\n';

    expect(placements(code)).toEqual([['F.', 'description']]);
  });
});

describe('violations', () => {
  it('Placement_CommentInsideAFunctionBody_IsInBody', () => {
    expect(placements('export function f() {\n  // step one\n  return 1;\n}\n')).toEqual([['step one', 'in-body']]);
  });

  it('Placement_JsdocOnANestedDeclaration_IsInBody', () => {
    expect(placements('export function f() {\n  /** Helper. */\n  const g = () => 1;\n  return g();\n}\n')).toEqual([['Helper.', 'in-body']]);
  });

  it('Placement_CommentInsideATestBody_IsInBody', () => {
    const code = 'export const x = 1;\ndescribe("s", () => {\n  it("c", () => {\n    // arrange\n    expect(1).toBe(1);\n  });\n});\n';

    expect(placements(code)).toEqual([['arrange', 'in-body']]);
  });

  it('Placement_CommentAboveAHelperInsideDescribe_IsInBody', () => {
    const code = 'export const x = 1;\ndescribe("s", () => {\n  /** Helper. */\n  const h = 1;\n});\n';

    expect(placements(code)).toEqual([['Helper.', 'in-body']]);
  });

  it('Placement_MethodBodyInAModuleLevelObject_IsInBody', () => {
    expect(placements('export const api = {\n  run() {\n    // inside\n    return 1;\n  },\n};\n')).toEqual([['inside', 'in-body']]);
  });

  it('Placement_CommentAfterCodeOnTheSameLine_IsTrailing', () => {
    expect(placements('export const a = 1; // the answer\n')).toEqual([['the answer', 'trailing']]);
  });

  it('Placement_LineCommentOnADeclaration_IsNonJsdoc', () => {
    expect(placements('export const x = 1;\n// The answer.\nexport const a = 42;\n')).toEqual([['The answer.', 'non-jsdoc']]);
  });

  it('Placement_LineCommentAboveATestCall_IsNonJsdoc', () => {
    expect(placements('export const x = 1;\ndescribe("s", () => {\n  // case\n  it("c", () => {});\n});\n')).toEqual([['case', 'non-jsdoc']]);
  });

  it('Placement_BlankLineAfterTheBlock_IsDetached', () => {
    expect(placements('export const x = 1;\n/** Orphan. */\n\nexport const a = 42;\n')).toEqual([['Orphan.', 'detached']]);
  });

  it('Placement_SectionBanner_IsABanner', () => {
    expect(placements('export const x = 1;\n// ─── Format inference ───────────────────\nexport const a = 42;\n')).toEqual([
      ['─── Format inference ───────────────────', 'banner'],
    ]);
  });

  it('Placement_CommentOnAnImportOrExpression_IsFloating', () => {
    const code = 'import a from "a";\n/** On an import. */\nimport b from "b";\n/** On an expression. */\nmain();\n';

    expect(placements(code).map(([, p]) => p)).toEqual(['floating', 'floating']);
  });

  it('Placement_CommentAtTheEndOfTheFile_IsFloating', () => {
    expect(placements('export const x = 1;\n/** Trailing doc. */\n')).toEqual([['Trailing doc.', 'floating']]);
  });

  it('Placement_CommentOnAUnionMemberOrParameter_IsFloating', () => {
    const code = 'export const x = 1;\nexport function f(\n  /** The id. */\n  id: string,\n) {}\n';

    expect(placements(code)).toEqual([['The id.', 'floating']]);
  });
});

describe('isBanner', () => {
  it('IsBanner_DecorationAndShortTitles_AreBanners', () => {
    expect(isBanner('// ─── Title ───────────')).toBe(true);
    expect(isBanner('// ==========\n// Section\n// ==========')).toBe(true);
  });

  it('IsBanner_TitleBetweenTwoDecorationRuns_IsABanner', () => {
    expect(isBanner('// ── structurally VALID ──')).toBe(true);
    expect(isBanner('// --- Inferred Types ---')).toBe(true);
    expect(isBanner('// ─── Registry-level suite (leak, zero-subscriber guard, property) ─────────')).toBe(true);
  });

  it('IsBanner_ProseAfterAOneSidedRun_IsNotABanner', () => {
    expect(isBanner('// ── Stand the REAL MCP server up over a REAL transport pair, then call it twice.')).toBe(false);
    expect(isBanner('// -- see the note above --flag')).toBe(false);
  });

  it('IsBanner_DecorationWithLongProse_IsNotABanner', () => {
    expect(isBanner('// ─── Cold start ───\n// The YAML loader is heavy, so the config path imports it only when a command needs it.')).toBe(false);
    expect(isBanner('// plain prose')).toBe(false);
  });
});
