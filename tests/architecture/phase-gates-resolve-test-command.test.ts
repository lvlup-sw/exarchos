// The four phase gates that run a repository's tests take the command from the
// toolchain resolver. This guard fails if one of them builds an `npm` or `npx`
// command. It parses each file and reads every string and template literal, so
// a comment does not count and a command kept in a variable still counts. It
// proves that it scanned all four files and that its matcher finds a seeded
// violation.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

/** The gates that must take their test command from the toolchain resolver. */
const GATE_FILES = [
  'src/verbs/team/prepare-synthesis.ts',
  'src/verbs/team/post-delegation-check.ts',
  'src/verbs/review/debug-review-gate.ts',
  'src/verbs/pure/post-merge.ts',
] as const;

/** A literal whose first word is `npm` or `npx`. */
const PACKAGE_MANAGER_COMMAND = /^\s*(?:npm|npx)(?:\s|$)/;

interface ScanResult {
  readonly literalCount: number;
  readonly violations: readonly string[];
}

/** Every string or template literal in `source` that starts an npm or npx command. */
function scanLiterals(fileName: string, source: string): ScanResult {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let literalCount = 0;
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      literalCount++;
      if (PACKAGE_MANAGER_COMMAND.test(node.text)) violations.push(node.text);
    } else if (ts.isTemplateExpression(node)) {
      literalCount++;
      if (PACKAGE_MANAGER_COMMAND.test(node.head.text)) violations.push(node.getText(sourceFile));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { literalCount, violations };
}

function scanGateFiles(): Map<string, ScanResult> {
  const results = new Map<string, ScanResult>();
  for (const rel of GATE_FILES) {
    const abs = path.join(REPO_ROOT, rel);
    if (!existsSync(abs)) continue;
    results.set(rel, scanLiterals(rel, readFileSync(abs, 'utf8')));
  }
  return results;
}

describe('phase gates resolve their test command', () => {
  /** A moved or renamed gate file would otherwise leave nothing to scan. */
  it('PhaseGateGuard_ScansAllFourGateFiles', () => {
    const results = scanGateFiles();

    expect([...results.keys()]).toEqual([...GATE_FILES]);
    for (const [rel, result] of results) {
      expect(result.literalCount, `${rel} parsed with no literals`).toBeGreaterThan(0);
    }
  });

  it('PhaseGateGuard_NoGateBuildsAnNpmOrNpxCommand', () => {
    const results = scanGateFiles();
    const offenders = Object.fromEntries(
      [...results]
        .filter(([, result]) => result.violations.length > 0)
        .map(([rel, result]) => [rel, result.violations]),
    );

    expect(results.size).toBe(GATE_FILES.length);
    expect(offenders).toEqual({});
  });

  /** Each seeded line is one form the gates used before they read the resolver. */
  it('PhaseGateGuard_Matcher_FindsSeededViolations', () => {
    const seeded = [
      "runCommandSync('npm', ['run', 'test:run'], { cwd: repoRoot });",
      "execSync('npm run typecheck', { cwd: repoRoot });",
      'execSync(`npx vitest run ${file}`);',
      'const command = "npx tsc --noEmit";',
      'execSync(command);',
    ].join('\n');

    expect(scanLiterals('seeded.ts', seeded).violations).toEqual([
      'npm',
      'npm run typecheck',
      '`npx vitest run ${file}`',
      'npx tsc --noEmit',
    ]);
  });

  /** The twin of the seeded case: comments and other programs do not match. */
  it('PhaseGateGuard_Matcher_IgnoresCommentsAndOtherPrograms', () => {
    const clean = [
      '// The old gate ran npm run test:run here.',
      "const resolved = resolveRunnableCommand(repoRoot, 'test');",
      "runCommandSync('go', ['test', './...'], { cwd: repoRoot });",
      "const label = 'npm-run-all is a different program';",
    ].join('\n');

    const result = scanLiterals('clean.ts', clean);

    expect(result.literalCount).toBeGreaterThan(0);
    expect(result.violations).toEqual([]);
  });
});
