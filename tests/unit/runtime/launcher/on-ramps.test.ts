/**
 * Tests for the launcher on-ramps and for the lifecycle wording of the Tier-1 runtime maps.
 *
 * Each on-ramp is a pure-data `HarnessDescriptor`. `harness-registry.type-test.ts` holds the
 * type-level pin for that, and the runtime checks here repeat it on the values.
 * Each `content/harness/runtimes/<id>.yaml` describes `isolation:worktree` as launcher-managed
 * lifecycle and makes no space-enforcement claim, because the launcher does not enforce space.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { HARNESS_ON_RAMPS } from '../../../../src/runtime/launcher/harnesses/index.js';
import { TIER1_HARNESSES, HARNESS_RUNTIME_ID } from '../../../../src/runtime/launcher/harness-registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** The repo root, four directories above this file. */
const REPO_ROOT = resolve(__dirname, '../../../..');

/** The runtime-map basenames of the Tier-1 harnesses, derived from the registry. */
const RUNTIME_IDS = TIER1_HARNESSES.map((t) => HARNESS_RUNTIME_ID[t]);

function runtimeYamlPath(runtimeId: string): string {
  return resolve(REPO_ROOT, 'content/harness/runtimes', `${runtimeId}.yaml`);
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

/** Tells if `value` is a function or holds one at any depth. It is the runtime twin of the type-level `HasFunctionDeep` pin. */
function containsFunctionDeep(value: unknown): boolean {
  if (typeof value === 'function') return true;
  if (Array.isArray(value)) return value.some(containsFunctionDeep);
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some(containsFunctionDeep);
  }
  return false;
}

describe('launcher on-ramps + runtimes lifecycle semantics (DR-1, DR-3)', () => {
  /**
   * The on-ramp keys equal `TIER1_HARNESSES`.
   * In each descriptor, `command` and `cwd` are strings, `args` and `env` hold only strings, and no field holds a function at any depth.
   */
  it('OnRamp_EachTier1_DeclarativeDescriptor', () => {
    expect(Object.keys(HARNESS_ON_RAMPS).sort()).toEqual([...TIER1_HARNESSES].sort());

    for (const target of TIER1_HARNESSES) {
      const descriptor = HARNESS_ON_RAMPS[target];

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

      expect(containsFunctionDeep(descriptor)).toBe(false);
    }
  });

  /** Each runtime map declares `isolation:worktree` as `native` or `advisory`, and its text holds the phrase "launcher-managed lifecycle". */
  it('Runtimes_IsolationSemantics_LauncherManagedLifecycle', () => {
    expect(RUNTIME_IDS).toEqual(['claude', 'codex', 'cursor', 'copilot', 'opencode']);

    for (const runtimeId of RUNTIME_IDS) {
      const raw = readRuntimeYaml(runtimeId);
      const parsed = parseRuntimeYaml(runtimeId);

      const isolation = parsed.supportedCapabilities?.['isolation:worktree'];
      expect(
        isolation,
        `${runtimeId}.yaml must still declare isolation:worktree`,
      ).toBeDefined();
      expect(['native', 'advisory']).toContain(isolation);

      expect(
        /launcher-managed lifecycle/i.test(raw),
        `${runtimeId}.yaml isolation:worktree must be framed as launcher-managed lifecycle`,
      ).toBe(true);
    }
  });

  /**
   * No runtime map holds a space-enforcement or confinement claim.
   * The test replaces each `#` and collapses whitespace first, so a claim that wraps across comment lines still matches.
   */
  it('Runtimes_NoSpaceEnforcementClaim', () => {
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
