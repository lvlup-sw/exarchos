// ─── Single-abstraction anti-drift structural guard (DR-4) ───────────────────
//
// DR-4's single-abstraction guarantee has two complementary halves:
//
//  1. LOAD-BEARING (elsewhere): the compile-time pure-data type-pin in
//     `harness-registry.type-test.ts` — a `HasFunctionDeep<HarnessDescriptor>`
//     conditional type that fails `tsc --noEmit` the moment `HarnessDescriptor`
//     (and, via Task 014, every on-ramp output typed as `HarnessDescriptor`)
//     gains any function-typed field. A green `tsc` is the real gate.
//
//  2. BACKSTOP (this file): a STRUCTURAL text-scan over the whole launcher
//     lifecycle surface that fails if per-harness *behavior* drift appears —
//     harness-name control-flow branching, or a literal harness-keyed *behavior*
//     (function-valued) map. The type-pin catches a behavior hook that hides
//     inside a descriptor's shape; this scan catches a behavior hook that hides
//     in the control flow *between* descriptors (an `if (harness === …)` ladder
//     or a `Record<Harness…, () => …>` dispatch table).
//
// SCOPE HONESTY (why the type-pin, not this scan, is load-bearing): a structural
// text-scan is a heuristic. It cannot catch a dynamically-built, cross-module, or
// runtime-id-keyed dispatch table (e.g. a behavior map assembled from imported
// function symbols, or keyed by a value computed at runtime). Those are covered
// ONLY by the compile-time type-pin. This scan is the cheap, fast backstop for
// the *textually obvious* drift the pin cannot see (control-flow branching is not
// a type-level property). Treat a green scan as necessary, never sufficient.
//
// The harness enum members are read from `TIER1_HARNESSES` (harness-registry.ts),
// NOT hardcoded here, so the guard tracks the enum as harnesses are added.
//
// Each named test embeds a DETECTOR SELF-TEST (synthetic bad + good fixtures)
// before it asserts on the real surface — this is the kill-probe made durable:
// it proves each scanner CAN fail, so a scanner that silently degrades to a
// no-op turns the test red here rather than rubber-stamping a drifted surface.
// (Mirrors the `detectorSelfTest` in `harness-registry.type-test.ts`.)
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIER1_HARNESSES, HARNESS_DESCRIPTORS } from './harness-registry.js';
import { HARNESS_ON_RAMPS } from './harnesses/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── The lifecycle surface the guard scans ────────────────────────────────────
// Every launcher PRODUCTION `.ts` file (excludes `*.test.ts` / `*.type-test.ts`),
// discovered recursively so a newly-added lifecycle module is scanned without a
// guard edit. The `harnesses/` on-ramp modules are included.

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

/** Path relative to the launcher dir, always forward-slashed (Windows-safe). */
function relKey(abs: string): string {
  return relative(__dirname, abs).split('\\').join('/');
}

// The task's "at minimum" lifecycle surface — asserted present so the guard can
// never silently scan an empty/partial set (e.g. if discovery regresses).
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

// ── Scanners (pure functions; run on both real files and synthetic fixtures) ──

interface Violation {
  readonly line: number;
  readonly rule: string;
  readonly snippet: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Strip `//` and block comments while preserving string/template literals and
 * line numbers (comment chars become spaces, newlines kept). This keeps doc
 * comments — which legitimately *describe* forbidden patterns ("no per-harness
 * branching") — from false-tripping the code-pattern scanners below, without
 * eating the string literals the scanners rely on (data-map keys, enum members).
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
    // string / template states — copy verbatim, honor escapes, detect close
    if (c === '\\') { out += c + (c2 ?? ''); i++; continue; }
    out += c;
    if (state === 'sq' && c === "'") state = 'code';
    else if (state === 'dq' && c === '"') state = 'code';
    else if (state === 'tpl' && c === '`') state = 'code';
  }
  return out;
}

/**
 * Harness-name control-flow branching:
 *  - `switch (<expr>)` whose discriminant references a harness identifier
 *    (name matches /harness/i) — catches `switch (harness)` / `switch(harnessTarget)`
 *    / `switch (ctx.harness)`, but NOT `switch (created.reason)`.
 *  - `case '<member>':` labels — a switch dispatching on a harness literal even
 *    under a differently-named discriminant.
 *  - `=== '<member>'` / `!== '<member>'` (either order) — an `if`/ternary literal
 *    harness-name conditional.
 * Members come from the live enum, so object-literal *keys* (`'claude-code': …`)
 * and bracket access (`HARNESS_DESCRIPTORS['claude-code']`) are NOT matched —
 * only `switch`/`case`/equality *control-flow* contexts are.
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
      if (/harness/i.test(m[1]!)) {
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
 * Literal harness-keyed BEHAVIOR map (function-valued) — the forbidden shape.
 * DATA maps (`Record<HarnessTarget, HarnessDescriptor>` — HARNESS_DESCRIPTORS,
 * HARNESS_ON_RAMPS) are explicitly ALLOWED and are the whole point of DR-4;
 * only FUNCTION-valued harness-keyed maps are caught:
 *  - `Record<Harness…, (…) => …>` — arrow-function value type.
 *  - `Record<Harness…, Fn>` — a value type whose single-identifier name ends in a
 *    function-alias suffix (Fn/Func/Function/Handler/Callback/Hook/Behavior).
 *    `HarnessDescriptor` / `RuntimeId` do NOT match, so data maps pass.
 *  - an object literal mapping a harness-member key directly to a function value
 *    (`'claude-code': () => …` / `codex: function …`).
 */
function scanHarnessKeyedBehaviorMap(source: string, members: readonly string[]): Violation[] {
  const stripped = stripComments(source);
  const fnAliasSuffix = /(?:Fn|Func|Function|Handler|Callback|Hook|Behavior)$/;
  const recordArrowRe = /Record<\s*Harness\w*\s*,\s*\([^)]*\)\s*=>/;
  const recordIdentRe = /Record<\s*Harness\w*\s*,\s*([A-Za-z_$][\w$]*)\s*>/;
  const keyPattern = (m: string): string => {
    const quoted = `['"]${escapeRegExp(m)}['"]`;
    // bare key only for valid identifiers (hyphenated members must be quoted)
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
    if (idm && fnAliasSuffix.test(idm[1]!)) {
      violations.push({ line: idx + 1, rule: 'record-harness-fn-alias', snippet: line.trim() });
    }
    if (memberFnRes.some((re) => re.test(line))) {
      violations.push({ line: idx + 1, rule: 'harness-key-fn-value', snippet: line.trim() });
    }
  });
  return violations;
}

/** Scan every real source file; return `file:line rule → snippet` report lines. */
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
  it('scans the required lifecycle surface (guard cannot silently scan nothing)', () => {
    const found = new Set(SOURCE_FILES.map(relKey));
    const missing = REQUIRED_SURFACE.filter((f) => !found.has(f));
    expect(missing, `missing lifecycle-surface files from scan set: ${missing.join(', ')}`).toEqual(
      [],
    );
    // sanity: the guard's own test + the type-test are excluded from the surface
    expect(found.has('single-abstraction.guard.test.ts')).toBe(false);
    expect(found.has('harness-registry.type-test.ts')).toBe(false);
  });

  it('LifecycleSurface_NoHarnessNameBranching', () => {
    // Detector self-test (kill-probe): the scanner MUST flag synthetic branching…
    const bad = [
      "switch (harness) { case 'claude-code': return a; default: return b; }",
      "if (harnessTarget === 'codex') { doCodexThing(); }",
      "const n = harness === 'cursor' ? 1 : 2;",
      "return ctx.harness === 'copilot';",
    ].join('\n');
    expect(scanHarnessNameBranching(bad, TIER1_HARNESSES).length).toBeGreaterThan(0);
    // …and MUST NOT flag legitimate non-harness branching or data-map access.
    const good = [
      "switch (created.reason) { case 'exists': return x; default: return y; }",
      "const d = HARNESS_DESCRIPTORS['claude-code'];",
      "  'claude-code': { command: 'claude', args: [], cwd: '.', env: {} },",
      "export type RuntimeId = 'claude' | 'codex' | 'cursor' | 'copilot' | 'opencode';",
      'const id = `exarchos-${harness}`;',
    ].join('\n');
    expect(scanHarnessNameBranching(good, TIER1_HARNESSES)).toEqual([]);

    // Real surface: no lifecycle-surface file may branch on a harness name.
    const report = scanSurface(scanHarnessNameBranching);
    expect(report, `harness-name branching found:\n${report.join('\n')}`).toEqual([]);
  });

  it('LifecycleSurface_NoLiteralHarnessKeyedBehaviorMap', () => {
    // Detector self-test (kill-probe): the scanner MUST flag function-valued maps…
    const bad = [
      'const m: Record<HarnessTarget, () => void> = build();',
      'let b: Record<Harness, Fn>;',
      "const beh = { 'claude-code': () => 1, codex: () => 2, cursor: () => 3 };",
      "const h = { copilot: async () => run(), opencode: function () {} };",
    ].join('\n');
    expect(scanHarnessKeyedBehaviorMap(bad, TIER1_HARNESSES).length).toBeGreaterThan(0);
    // …and MUST NOT flag the allowed pure-DATA maps or unrelated Records.
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

    // Real surface: no lifecycle-surface file declares a harness-keyed BEHAVIOR map.
    const report = scanSurface(scanHarnessKeyedBehaviorMap);
    expect(report, `harness-keyed behavior map found:\n${report.join('\n')}`).toEqual([]);

    // Positive assertion — the two harness-keyed maps stay DATA (value type
    // `HarnessDescriptor`, never a function), at both the source-annotation and
    // the runtime-value level.
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

  it('Descriptor_TypeLevel_PureData', () => {
    // Anchor the LOAD-BEARING compile-time pin so a future removal of it is
    // caught here. NOTE: `tsc --noEmit` is the REAL gate — the `HasFunctionDeep`
    // conditional type collapses `AssertPureData<HarnessDescriptor>` to `never`
    // and fails the build the instant a function-typed field appears. This test
    // only guards the pin's continued *existence*, not the type check itself.
    const typeTestPath = resolve(__dirname, 'harness-registry.type-test.ts');
    expect(existsSync(typeTestPath)).toBe(true);
    const src = readFileSync(typeTestPath, 'utf8');
    expect(src).toMatch(/HasFunctionDeep/);
    expect(src).toMatch(/AssertPureData<\s*HarnessDescriptor\s*>/);
    // the conditional-type assertion is bound to a real declaration `tsc` gates on
    expect(src).toMatch(/const\s+pureDataAssertionHolds\s*:\s*AssertPureData<\s*HarnessDescriptor\s*>/);
  });
});
