/**
 * The decision that admits the verification profile moves the digest of the prepared bundle only.
 * The prepared bundle embeds the capsule, and the capsule gains an optional profile.
 * The settlement bundle holds only the identity of its capsule, so it and the other stored shapes keep their digests.
 * The digest rule is the rule of `identifier-stability.test.ts`: the canonical JSON Schema with each description removed.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { zodToJsonSchema } from '../../src/utils/json-schema.js';
import { requestDigest } from '../../src/contract/request-context.js';
import { SCHEMA_VERSION } from '../../src/storage/sqlite/schema.js';
import { ExecutionSettledData } from '../../src/events/schemas.js';
import { SettlementBundleV1Schema } from '../../src/verbs/settle/settlement-bundle.js';
import { ClaimTraceSchema } from '../../src/verbs/settle/claim-codec.js';
import { PreparedBundleV1Schema } from '../../src/verbs/prepare/prepared-record.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

/** The part of the snapshot that this test reads: the log of the stored-shape decisions. */
const StoredShapeLogSchema = z.object({
  storedShapes: z.object({
    decisions: z.array(
      z.object({
        date: z.string(),
        source: z.string(),
        decision: z.string(),
        schemaVersion: z.number(),
        shapes: z.record(z.string(), z.string()),
      }),
    ),
  }),
});

const decisions = StoredShapeLogSchema.parse(
  JSON.parse(readFileSync(path.join(REPO_ROOT, 'tools/audit/registered-actions-snapshot.json'), 'utf8')),
).storedShapes.decisions;

/** A copy of a JSON Schema with each description removed. A description is text for a reader and not part of the shape. */
function withoutDescriptions(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutDescriptions);
  if (node === null || typeof node !== 'object') return node;
  const entries: [string, unknown][] = Object.entries(node);
  return Object.fromEntries(
    entries
      .filter(([key, value]) => !(key === 'description' && typeof value === 'string'))
      .map(([key, value]) => [key, withoutDescriptions(value)]),
  );
}

/** The digest of one stored shape. */
function shapeDigest(schema: z.ZodType): string {
  return requestDigest(withoutDescriptions(zodToJsonSchema(schema)));
}

/** The stored shapes that the profile does not change. */
const UNCHANGED_SHAPES: Readonly<Record<string, z.ZodType>> = {
  ClaimTraceSchema,
  ExecutionSettledData,
  SettlementBundleV1Schema,
};

describe('the stored-shape decision of the verification profile', () => {
  /**
   * The profile decision is the latest entry, and it names the design of record.
   * With the profile reverted, the live prepared-bundle digest equals the entry of 2026-10-25, so the last assertion fails.
   */
  it('StoredShapes_TheProfileDecision_MovesOnlyThePreparedBundleDigest', () => {
    const scopeDecision = decisions.find((entry) => entry.date === '2026-10-25');
    const profileDecision = decisions.at(-1);
    expect(scopeDecision, 'the decision of 2026-10-25 is absent').toBeDefined();
    expect(profileDecision?.source).toContain('docs/specs/2026-10-28-no-per-language-code.md');
    expect(profileDecision?.decision).toContain('SCHEMA_VERSION stays 6');
    expect(profileDecision?.decision).toContain('`verificationProfile`');
    expect(profileDecision?.decision).toContain('`exarchos-prepare-5`');
    expect(profileDecision?.schemaVersion).toBe(SCHEMA_VERSION);

    for (const [name, schema] of Object.entries(UNCHANGED_SHAPES)) {
      expect(shapeDigest(schema), name).toBe(scopeDecision?.shapes[name]);
      expect(profileDecision?.shapes[name], name).toBe(scopeDecision?.shapes[name]);
    }
    const prepared = shapeDigest(PreparedBundleV1Schema);
    expect(profileDecision?.shapes.PreparedBundleV1Schema).toBe(prepared);
    expect(prepared).not.toBe(scopeDecision?.shapes.PreparedBundleV1Schema);
  });
});
