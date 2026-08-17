// ─── The SHIPPED generated-artifact authorities (P05-05) ─────────────────────
//
// PROGRAM-05, the closure capstone (CTR-013). Typed, fail-loud readers for the
// CHECKED-IN artifacts that other generation passes ship:
//
//   • `compiler/generated/proof-fixtures.json` — P03-03's packaged proof
//     baseline (per action: descriptor / schema / policy digests + the bound
//     error-family and output-kind contract); and
//   • `cli/generated/cli-surface.json`          — P03-05's shipped CLI client
//     surface (per action: the command the packaged client exposes).
//
// ── Why these are read from DISK ─────────────────────────────────────────────
// The reachability census's denominator comes from `compile(deriveMetaModel())`.
// Any hop re-derived from THAT SAME in-process compile is a tautology: it
// resolves for every action by construction and can never surface a break. These
// two files are produced by DIFFERENT generation passes and are committed, so
// comparing the live compile against them is a real edge with real teeth: it
// fails when the shipped artifacts and the live contract disagree (a stale
// baseline, a hand-edited artifact, a half-regenerated surface).
//
// Every reader is strict: an absent file, a wrong-shaped body, or an entry that
// is missing a required field THROWS. A lenient reader that skipped malformed
// entries would understate the shipped surface and mis-report a closure break.
// ────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';

import { PROOF_FIXTURES_FILE } from '../compiler/generate.js';
import { CLI_SURFACE_FILE } from '../cli/cli-contract-seam.js';

/** Thrown when a shipped generated artifact cannot be read as an authority. */
export class ShippedArtifactError extends Error {
  override readonly name = 'ShippedArtifactError';
}

// ─── Narrowing helpers (no `any`; `unknown` + guards) ────────────────────────

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readJson(file: string, what: string): unknown {
  if (!fs.existsSync(file)) {
    throw new ShippedArtifactError(`shipped ${what} '${file}' does not exist`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch (err) {
    throw new ShippedArtifactError(
      `shipped ${what} '${file}' is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function requireArray(body: unknown, key: string, file: string, what: string): readonly unknown[] {
  if (!isRecord(body)) {
    throw new ShippedArtifactError(`shipped ${what} '${file}' is not a JSON object`);
  }
  const value = body[key];
  if (!Array.isArray(value)) {
    throw new ShippedArtifactError(`shipped ${what} '${file}' has no '${key}' array`);
  }
  return value;
}

function requireString(entry: Readonly<Record<string, unknown>>, key: string, ctx: string): string {
  const value = entry[key];
  if (typeof value !== 'string') {
    throw new ShippedArtifactError(`${ctx} has no string '${key}'`);
  }
  return value;
}

function requireStringArray(
  entry: Readonly<Record<string, unknown>>,
  key: string,
  ctx: string,
): readonly string[] {
  const value = entry[key];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new ShippedArtifactError(`${ctx} has no string[] '${key}'`);
  }
  return value.filter((v): v is string => typeof v === 'string');
}

// ─── The packaged proof-fixture baseline (P03-03, checked in) ────────────────

/** One action's entry in the SHIPPED proof-fixture baseline. */
export interface ShippedActionFixture {
  readonly actionId: string;
  readonly descriptorDigest: string;
  readonly inputSchemaDigest: string;
  readonly outputSchemaDigest: string;
  readonly policyDigest: string;
  /** The error families the SHIPPED baseline records for the action. */
  readonly errorCodes: readonly string[];
  /** The output kinds the SHIPPED baseline records for the action. */
  readonly outputKinds: readonly string[];
}

/**
 * Read the checked-in proof-fixture baseline. Strict: every entry must carry the
 * full digest set and its bound output contract.
 */
export function readShippedProofFixtures(
  file: string = PROOF_FIXTURES_FILE,
): readonly ShippedActionFixture[] {
  const entries = requireArray(readJson(file, 'proof-fixture baseline'), 'actions', file, 'proof-fixture baseline');
  return entries.map((raw, index): ShippedActionFixture => {
    const ctx = `shipped proof fixture '${file}' entry [${index}]`;
    if (!isRecord(raw)) throw new ShippedArtifactError(`${ctx} is not an object`);
    return {
      actionId: requireString(raw, 'actionId', ctx),
      descriptorDigest: requireString(raw, 'descriptorDigest', ctx),
      inputSchemaDigest: requireString(raw, 'inputSchemaDigest', ctx),
      outputSchemaDigest: requireString(raw, 'outputSchemaDigest', ctx),
      policyDigest: requireString(raw, 'policyDigest', ctx),
      errorCodes: requireStringArray(raw, 'errorCodes', ctx),
      outputKinds: requireStringArray(raw, 'outputKinds', ctx),
    };
  });
}

// ─── The shipped CLI client surface (P03-05, checked in) ─────────────────────

/** One action's command in the SHIPPED CLI-surface artifact. */
export interface ShippedCliCommand {
  readonly actionId: string;
  readonly commandName: string;
}

/**
 * Read the checked-in CLI-surface baseline — the packaged client artifact that
 * exposes each ActionId as a command. Independent of the contract compiler's
 * in-process output: it is a separate generation pass's committed result.
 */
export function readShippedCliCommands(file: string = CLI_SURFACE_FILE): readonly ShippedCliCommand[] {
  const entries = requireArray(readJson(file, 'CLI-surface baseline'), 'commands', file, 'CLI-surface baseline');
  return entries.map((raw, index): ShippedCliCommand => {
    const ctx = `shipped CLI command '${file}' entry [${index}]`;
    if (!isRecord(raw)) throw new ShippedArtifactError(`${ctx} is not an object`);
    return {
      actionId: requireString(raw, 'actionId', ctx),
      commandName: requireString(raw, 'commandName', ctx),
    };
  });
}
