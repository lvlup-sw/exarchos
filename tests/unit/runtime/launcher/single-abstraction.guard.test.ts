/**
 * Structural guard against per-harness behavior in the launcher lifecycle surface.
 *
 * The scan reads each launcher source file as text. It fails on control flow that branches on a
 * harness name, and on a harness-keyed map with function values.
 * The harness names come from `TIER1_HARNESSES`. Each scanner test first runs its scanner on
 * synthetic bad and good fixtures, so a scanner that reports nothing fails the test.
 *
 * The type-level pin in `harness-registry.type-test.ts` is the primary gate for a function in a
 * descriptor, and it holds only when `tsc` compiles that file. A text scan cannot see a dispatch
 * table that is built at runtime or across modules. Thus a green scan is necessary but not sufficient.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIER1_HARNESSES, HARNESS_DESCRIPTORS } from '../../../../src/runtime/launcher/harness-registry.js';
import { HARNESS_ON_RAMPS } from '../../../../src/runtime/launcher/harnesses/index.js';

const __dirname = fileURLToPath(new URL('../../../../src/runtime/launcher/', import.meta.url));

/** Collects each `.ts` file under `dir` at any depth, except test files. Thus a new lifecycle module needs no guard edit. */
function collectLauncherSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectLauncherSourceFiles(abs));
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.type-test.ts')) continue;
    out.push(abs);
  }
  return out;
}

const SOURCE_FILES = collectLauncherSourceFiles(__dirname);

/** The path relative to the launcher directory, with forward slashes on each platform. */
function relKey(abs: string): string {
  return relative(__dirname, abs).split('\\').join('/');
}

/** The files that the scan set must include. The first test asserts them, so the guard cannot scan an empty or partial set. */
const REQUIRED_SURFACE = [
  'lifecycle-core.ts',
  'signals.ts',
  'teardown.ts',
  'liveness.ts',
  'create-worktree.ts',
  'injection-seam.ts',
  'verb.ts',
  'wlm-compose.ts',
  'launch-reconcile.ts',
  'topology.ts',
  'harness-registry.ts',
  'harnesses/index.ts',
  'harnesses/claude-code.ts',
  'harnesses/codex.ts',
  'harnesses/cursor.ts',
  'harnesses/copilot.ts',
  'harnesses/opencode.ts',
];

interface Violation {
  readonly line: number;
  readonly rule: string;
  readonly snippet: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replaces `//` and block comments with spaces, and keeps string literals, template literals and line numbers.
 * Thus a comment that describes a forbidden pattern does not trip a scanner.
 */
function stripComments(src: string): string {
  let out = '';
  let state: 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl' = 'code';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === 'code') {
      if (c === '/' && c2 === '/') { out += '  '; i++; state = 'line'; continue; }
      if (c === '/' && c2 === '*') { out += '  '; i++; state = 'block'; continue; }
      if (c === "'") { state = 'sq'; }
      else if (c === '"') { state = 'dq'; }
      else if (c === '`') { state = 'tpl'; }
      out += c;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') { out += c; state = 'code'; continue; }
      out += c === '\t' ? '\t' : ' ';
      continue;
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') { out += '  '; i++; state = 'code'; continue; }
      out += c === '\n' ? '\n' : c === '\t' ? '\t' : ' ';
      continue;
    }
    if (c === '\\') { out += c + (c2 ?? ''); i++; continue; }
    out += c;
    if (state === 'sq' && c === "'") state = 'code';
    else if (state === 'dq' && c === '"') state = 'code';
    else if (state === 'tpl' && c === '`') state = 'code';
  }
  return out;
}

/**
 * Finds control flow that branches on a harness name. It reports three shapes:
 *  - `switch (<name>)` where the name or dotted path contains "harness", in upper or lower case.
 *  - A `case '<member>':` label.
 *  - `===` or `!==` against a `'<member>'` literal, in either order.
 * It does not match an object-literal key or a bracket access that holds a member name.
 */
function scanHarnessNameBranching(source: string, members: readonly string[]): Violation[] {
  const stripped = stripComments(source);
  const memberAlt = members.map(escapeRegExp).join('|');
  const caseRe = new RegExp(`\\bcase\\s+['"](?:${memberAlt})['"]`);
  const eqRe = new RegExp(
    `(?:===|!==)\\s*['"](?:${memberAlt})['"]|['"](?:${memberAlt})['"]\\s*(?:===|!==)`,
  );
  const switchRe = /\bswitch\s*\(\s*([A-Za-z_$][\w$.]*)\s*\)/g;
  const violations: Violation[] = [];
  stripped.split('\n').forEach((line, idx) => {
    switchRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = switchRe.exec(line)) !== null) {
      if (/harness/i.test(m[1])) {
        violations.push({ line: idx + 1, rule: 'switch-on-harness', snippet: line.trim() });
      }
    }
    if (caseRe.test(line)) {
      violations.push({ line: idx + 1, rule: 'case-harness-literal', snippet: line.trim() });
    }
    if (eqRe.test(line)) {
      violations.push({ line: idx + 1, rule: 'equality-harness-literal', snippet: line.trim() });
    }
  });
  return violations;
}

/**
 * Finds a harness-keyed map with function values. A data map such as
 * `Record<HarnessTarget, HarnessDescriptor>` passes. It reports three shapes:
 *  - `Record<Harness…, (…) => …>`, an arrow-function value type.
 *  - `Record<Harness…, X>` where the name `X` ends in Fn, Func, Function, Handler, Callback, Hook or Behavior.
 *  - An object-literal entry that maps a member key to a `(…) =>` arrow function or a `function` expression.
 * A member that is not a valid identifier matches only as a quoted key.
 */
function scanHarnessKeyedBehaviorMap(source: string, members: readonly string[]): Violation[] {
  const stripped = stripComments(source);
  const fnAliasSuffix = /(?:Fn|Func|Function|Handler|Callback|Hook|Behavior)$/;
  const recordArrowRe = /Record<\s*Harness\w*\s*,\s*\([^)]*\)\s*=>/;
  const recordIdentRe = /Record<\s*Harness\w*\s*,\s*([A-Za-z_$][\w$]*)\s*>/;
  const keyPattern = (m: string): string => {
    const quoted = `['"]${escapeRegExp(m)}['"]`;
    return /^[A-Za-z_$][\w$]*$/.test(m) ? `(?:${quoted}|(?<![\\w$])${escapeRegExp(m)})` : quoted;
  };
  const memberFnRes = members.map(
    (m) =>
      new RegExp(
        `${keyPattern(m)}\\s*:\\s*(?:async\\s+)?(?:\\([^)]*\\)\\s*(?::[^=;{]+)?=>|function\\b)`,
      ),
  );
  const violations: Violation[] = [];
  stripped.split('\n').forEach((line, idx) => {
    if (recordArrowRe.test(line)) {
      violations.push({ line: idx + 1, rule: 'record-harness-arrow', snippet: line.trim() });
    }
    const idm = recordIdentRe.exec(line);
    if (idm && fnAliasSuffix.test(idm[1])) {
      violations.push({ line: idx + 1, rule: 'record-harness-fn-alias', snippet: line.trim() });
    }
    if (memberFnRes.some((re) => re.test(line))) {
      violations.push({ line: idx + 1, rule: 'harness-key-fn-value', snippet: line.trim() });
    }
  });
  return violations;
}

/** Runs `scanner` on each source file and returns one `file:line [rule] → snippet` line for each violation. */
function scanSurface(
  scanner: (src: string, members: readonly string[]) => Violation[],
): string[] {
  const report: string[] = [];
  for (const abs of SOURCE_FILES) {
    const src = readFileSync(abs, 'utf8');
    for (const v of scanner(src, TIER1_HARNESSES)) {
      report.push(`${relKey(abs)}:${v.line} [${v.rule}] → ${v.snippet}`);
    }
  }
  return report;
}

describe('single-abstraction anti-drift structural guard (DR-4)', () => {
  /** The scan set includes each `REQUIRED_SURFACE` file, and excludes this test and the type test. */
  it('scans the required lifecycle surface (guard cannot silently scan nothing)', () => {
    const found = new Set(SOURCE_FILES.map(relKey));
    const missing = REQUIRED_SURFACE.filter((f) => !found.has(f));
    expect(missing, `missing lifecycle-surface files from scan set: ${missing.join(', ')}`).toEqual(
      [],
    );
    expect(found.has('single-abstraction.guard.test.ts')).toBe(false);
    expect(found.has('harness-registry.type-test.ts')).toBe(false);
  });

  /**
   * Self-test first: the scanner reports the synthetic branching, and reports nothing for the good fixture.
   * Then no file in the lifecycle surface branches on a harness name.
   */
  it('LifecycleSurface_NoHarnessNameBranching', () => {
    const bad = [
      "switch (harness) { case 'claude-code': return a; default: return b; }",
      "if (harnessTarget === 'codex') { doCodexThing(); }",
      "const n = harness === 'cursor' ? 1 : 2;",
      "return ctx.harness === 'copilot';",
    ].join('\n');
    expect(scanHarnessNameBranching(bad, TIER1_HARNESSES).length).toBeGreaterThan(0);
    const good = [
      "switch (created.reason) { case 'exists': return x; default: return y; }",
      "const d = HARNESS_DESCRIPTORS['claude-code'];",
      "  'claude-code': { command: 'claude', args: [], cwd: '.', env: {} },",
      "export type RuntimeId = 'claude' | 'codex' | 'cursor' | 'copilot' | 'opencode';",
      'const id = `exarchos-${harness}`;',
    ].join('\n');
    expect(scanHarnessNameBranching(good, TIER1_HARNESSES)).toEqual([]);

    const report = scanSurface(scanHarnessNameBranching);
    expect(report, `harness-name branching found:\n${report.join('\n')}`).toEqual([]);
  });

  /**
   * Self-test first: the scanner reports the function-valued maps, and reports nothing for the data maps.
   * Then no file in the lifecycle surface declares a harness-keyed behavior map.
   * The two harness-keyed maps keep the value type `HarnessDescriptor` in source, and hold only objects at runtime.
   */
  it('LifecycleSurface_NoLiteralHarnessKeyedBehaviorMap', () => {
    const bad = [
      'const m: Record<HarnessTarget, () => void> = build();',
      'let b: Record<Harness, Fn>;',
      "const beh = { 'claude-code': () => 1, codex: () => 2, cursor: () => 3 };",
      "const h = { copilot: async () => run(), opencode: function () {} };",
    ].join('\n');
    expect(scanHarnessKeyedBehaviorMap(bad, TIER1_HARNESSES).length).toBeGreaterThan(0);
    const good = [
      'export const HARNESS_DESCRIPTORS: Readonly<Record<HarnessTarget, HarnessDescriptor>> = {',
      'export const HARNESS_RUNTIME_ID: Readonly<Record<HarnessTarget, RuntimeId>> = {',
      'export const HARNESS_ON_RAMPS: Readonly<Record<HarnessTarget, HarnessDescriptor>> = {',
      "  'claude-code': claudeCodeOnRamp,",
      "  'claude-code': { command: 'claude', args: [], cwd: '.', env: {} },",
      '  readonly env: Record<string, string>;',
      '  const rawInput = raw as Record<string, unknown>;',
    ].join('\n');
    expect(scanHarnessKeyedBehaviorMap(good, TIER1_HARNESSES)).toEqual([]);

    const report = scanSurface(scanHarnessKeyedBehaviorMap);
    expect(report, `harness-keyed behavior map found:\n${report.join('\n')}`).toEqual([]);

    const registrySrc = readFileSync(resolve(__dirname, 'harness-registry.ts'), 'utf8');
    const onRampsSrc = readFileSync(resolve(__dirname, 'harnesses', 'index.ts'), 'utf8');
    expect(registrySrc).toMatch(
      /HARNESS_DESCRIPTORS\s*:\s*Readonly<Record<HarnessTarget,\s*HarnessDescriptor>>/,
    );
    expect(onRampsSrc).toMatch(
      /HARNESS_ON_RAMPS\s*:\s*Readonly<Record<HarnessTarget,\s*HarnessDescriptor>>/,
    );
    for (const map of [HARNESS_DESCRIPTORS, HARNESS_ON_RAMPS]) {
      const values = Object.values(map);
      expect(values.length).toBe(TIER1_HARNESSES.length);
      expect(values.every((v) => typeof v === 'object' && v !== null)).toBe(true);
      expect(values.some((v) => typeof v === 'function')).toBe(false);
    }
  });

  /**
   * `harness-registry.type-test.ts` still holds the type-level pin, bound to the `pureDataAssertionHolds` declaration.
   * Only a `tsc` compile of that file does the type check. This test only detects removal of the pin.
   */
  it('Descriptor_TypeLevel_PureData', () => {
    const typeTestPath = resolve(__dirname, '../../../tests/unit/runtime/launcher/harness-registry.type-test.ts');
    expect(existsSync(typeTestPath)).toBe(true);
    const src = readFileSync(typeTestPath, 'utf8');
    expect(src).toMatch(/HasFunctionDeep/);
    expect(src).toMatch(/AssertPureData<\s*HarnessDescriptor\s*>/);
    expect(src).toMatch(/const\s+pureDataAssertionHolds\s*:\s*AssertPureData<\s*HarnessDescriptor\s*>/);
  });
});
