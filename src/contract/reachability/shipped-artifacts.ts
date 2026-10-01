/**
 * Strict readers for two checked-in generated artifacts: `compiler/generated/proof-fixtures.json`
 * and `cli/generated/cli-surface.json`.
 * The reachability census compares the live compile against these files. Separate generation passes
 * write them, so the comparison fails when the shipped artifacts and the live contract disagree.
 * An absent file, a body with the wrong shape, or an entry with a missing field throws. A lenient
 * reader understates the shipped surface and misreports a closure break.
 */

import fs from 'node:fs';

import { PROOF_FIXTURES_FILE } from '../compiler/generate.js';
import { CLI_SURFACE_FILE } from '../cli/cli-contract-seam.js';

/** Thrown when a shipped generated artifact cannot be read as an authority. */
export class ShippedArtifactError extends Error {
  override readonly name = 'ShippedArtifactError';
}

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

/** Reads the checked-in proof-fixture baseline. Every entry must carry all digests and its output contract. */
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

/** One action's command in the SHIPPED CLI-surface artifact. */
export interface ShippedCliCommand {
  readonly actionId: string;
  readonly commandName: string;
}

/** Reads the checked-in CLI-surface baseline, which maps each ActionId to a command. */
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
