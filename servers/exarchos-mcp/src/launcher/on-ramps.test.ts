// ─── Per-harness on-ramps + runtimes/*.yaml lifecycle semantics (DR-1, DR-3) ──
//
// Two guarantees, one file:
//
//   1. The five Tier-1 launcher **on-ramps** (`harnesses/*.ts`) each yield a
//      *declarative* `HarnessDescriptor` — pure data, no behavior. (The real
//      pure-data guarantee is the compile-time pin in
//      `harness-registry.type-test.ts`, inherited because every on-ramp output
//      is typed `HarnessDescriptor`; the runtime checks here are belt-and-braces.)
//
//   2. Every Tier-1 `runtimes/*.yaml` now frames `isolation:worktree` as
//      **launcher-managed lifecycle** (the launcher owns the harness process +
//      top-level worktree lifecycle) and carries **no space-enforcement /
//      P-S-N / confinement claim** (space enforcement is an explicit non-goal —
//      kernel/harness territory, handed to #1601).
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { HARNESS_ON_RAMPS } from './harnesses/index.js';
import { TIER1_HARNESSES, HARNESS_RUNTIME_ID } from './harness-registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// servers/exarchos-mcp/src/launcher → repo root is four parents up.
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');

/** The five Tier-1 runtime-map basenames, derived from the registry (no hardcoded list — INV-4). */
const RUNTIME_IDS = TIER1_HARNESSES.map((t) => HARNESS_RUNTIME_ID[t]);

function runtimeYamlPath(runtimeId: string): string {
  return resolve(REPO_ROOT, 'runtimes', `${runtimeId}.yaml`);
}

function readRuntimeYaml(runtimeId: string): string {
  return readFileSync(runtimeYamlPath(runtimeId), 'utf8');
}

interface RuntimeYamlShape {
  readonly supportedCapabilities?: Record<string, string>;
}

function parseRuntimeYaml(runtimeId: string): RuntimeYamlShape {
  const parsed: unknown = parseYaml(readRuntimeYaml(runtimeId));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Expected ${runtimeId}.yaml to parse to an object`);
  }
  return parsed as RuntimeYamlShape;
}

/**
 * `true` iff `value` is, or (recursively) contains, a function — the runtime
 * mirror of the compile-time `HasFunctionDeep` pin. Guards against a behavior
 * hook smuggled into a descriptor.
 */
function containsFunctionDeep(value: unknown): boolean {
  if (typeof value === 'function') return true;
  if (Array.isArray(value)) return value.some(containsFunctionDeep);
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some(containsFunctionDeep);
  }
  return false;
}

describe('launcher on-ramps + runtimes lifecycle semantics (DR-1, DR-3)', () => {
  it('OnRamp_EachTier1_DeclarativeDescriptor', () => {
    // Exactly the five Tier-1 harnesses on-ramp, no more, no fewer.
    expect(Object.keys(HARNESS_ON_RAMPS).sort()).toEqual([...TIER1_HARNESSES].sort());

    for (const target of TIER1_HARNESSES) {
      const descriptor = HARNESS_ON_RAMPS[target];

      // Declarative pure-data shape: primitive/array/record fields only.
      expect(typeof descriptor.command).toBe('string');
      expect(descriptor.command.length).toBeGreaterThan(0);
      expect(Array.isArray(descriptor.args)).toBe(true);
      for (const arg of descriptor.args) expect(typeof arg).toBe('string');
      expect(typeof descriptor.cwd).toBe('string');
      expect(descriptor.env).toBeTypeOf('object');
      expect(descriptor.env).not.toBeNull();
      for (const envValue of Object.values(descriptor.env)) {
        expect(typeof envValue).toBe('string');
      }

      // No behavior can hide in an on-ramp — no field is, or nests, a function.
      expect(containsFunctionDeep(descriptor)).toBe(false);
    }
  });

  it('Runtimes_IsolationSemantics_LauncherManagedLifecycle', () => {
    expect(RUNTIME_IDS).toEqual(['claude', 'codex', 'cursor', 'copilot', 'opencode']);

    for (const runtimeId of RUNTIME_IDS) {
      const raw = readRuntimeYaml(runtimeId);
      const parsed = parseRuntimeYaml(runtimeId);

      // isolation:worktree is still a declared capability (structural).
      const isolation = parsed.supportedCapabilities?.['isolation:worktree'];
      expect(
        isolation,
        `${runtimeId}.yaml must still declare isolation:worktree`,
      ).toBeDefined();
      expect(['native', 'advisory']).toContain(isolation);

      // …and its semantics are now framed as launcher-managed lifecycle.
      expect(
        /launcher-managed lifecycle/i.test(raw),
        `${runtimeId}.yaml isolation:worktree must be framed as launcher-managed lifecycle`,
      ).toBe(true);
    }
  });

  it('Runtimes_NoSpaceEnforcementClaim', () => {
    // Space-enforcement / P-S-N / confinement framing that must NOT survive in
    // any Tier-1 runtime map (space enforcement is a non-goal — handed to #1601).
    const FORBIDDEN: readonly RegExp[] = [
      /confinement/i,
      /cannot enforce/i,
      /enforce(?:s|d|ment)? the boundary/i,
      /enforcement primitive/i,
      /\bP\/S\/N\b/,
      /space[- ]?enforcement/i,
      /space[- ]?moat/i,
      /write[- ]?leak/i,
      /pass[- ]?through[- ]?p\b/i,
    ];

    for (const runtimeId of RUNTIME_IDS) {
      // Normalize so a claim wrapped across comment lines is still caught.
      const normalized = readRuntimeYaml(runtimeId)
        .replace(/#/g, ' ')
        .replace(/\s+/g, ' ');
      for (const pattern of FORBIDDEN) {
        expect(
          pattern.test(normalized),
          `${runtimeId}.yaml carries a forbidden space-enforcement claim: ${pattern}`,
        ).toBe(false);
      }
    }
  });
});
