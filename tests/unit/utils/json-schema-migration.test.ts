/**
 * Four `zodToJsonSchema()` call sites in `src/` go through `src/utils/json-schema.ts`.
 * A call site with no `target` emits the 2020-12 `$schema` URI.
 * `projections/rehydration/fingerprint.ts` passes `target: 'draft-07'`, and the wrapper
 * must keep that target. A different target changes the hash in `PREFIX_FINGERPRINT`.
 */
import { describe, it, expect } from 'vitest';

import { handleDescribe } from '../../../src/describe/handler.js';
import { handleRunbook } from '../../../src/runbooks/handler.js';
import { resolveSchemaRef } from '../../../src/adapters/cli/schema-introspection.js';
import { computePrefixFingerprint } from '../../../src/projections/rehydration/fingerprint.js';
import { StableSectionsSchema } from '../../../src/projections/rehydration/schema.js';
import { zodToJsonSchema } from '../../../src/utils/json-schema.js';
import { TOOL_REGISTRY } from '../../../src/registry.js';
import { JSON_SCHEMA_2020_12_URI } from '../../../src/utils/json-schema.js';

/** The draft-07 `$schema` URIs that the suite accepts, with the trailing `#` and without it. */
const DRAFT_07_URIS = new Set<string>([
  'http://json-schema.org/draft-07/schema#',
  'https://json-schema.org/draft-07/schema',
]);

describe('EmittedSchemas_Use2020_12ForAllCallSites_PerFile', () => {
  it('describe/handler.ts emits 2020-12 $schema (no explicit target)', async () => {
    const workflowTool = TOOL_REGISTRY.find((t) => t.name === 'exarchos_workflow');
    expect(workflowTool, 'workflow tool present in registry').toBeDefined();

    const result = await handleDescribe(
      { actions: ['init'] },
      workflowTool!.actions,
    );
    expect(result.success).toBe(true);

    const data = result.data as Record<string, Record<string, unknown>>;
    const schema = data.init.schema as Record<string, unknown>;
    expect(schema).toBeDefined();
    expect(schema.$schema).toBe(JSON_SCHEMA_2020_12_URI);
  });

  /** Each non-native step of `task-completion` resolves its action schema through `zodToJsonSchema`. */
  it('runbooks/handler.ts emits 2020-12 $schema for resolved step schemas (no explicit target)', async () => {
    const result = await handleRunbook({ id: 'task-completion' });
    expect(result.success).toBe(true);

    const data = result.data as { steps: Array<{ schema: unknown }> };
    expect(Array.isArray(data.steps)).toBe(true);
    expect(data.steps.length).toBeGreaterThan(0);

    const firstResolved = data.steps.find(
      (s) => s.schema !== null && typeof s.schema === 'object',
    );
    expect(firstResolved, 'at least one resolved-schema step').toBeDefined();
    const schema = firstResolved!.schema as Record<string, unknown>;
    expect(schema.$schema).toBe(JSON_SCHEMA_2020_12_URI);
  });

  it('adapters/schema-introspection.ts emits 2020-12 $schema via resolveSchemaRef (no explicit target)', () => {
    const schema = resolveSchemaRef('workflow.init');
    expect(schema.$schema).toBe(JSON_SCHEMA_2020_12_URI);
  });

  /**
   * The test calls the wrapper with `target: 'draft-07'` and expects a draft-07 URI.
   * It then expects `computePrefixFingerprint` to return the same SHA-256 hex digest on two calls.
   * It does not pin the digest. `tools/audit/gates/check-prefix-fingerprint.mjs` does that.
   */
  it('projections/rehydration/fingerprint.ts preserves draft-07 (caller passes explicit `target: draft-07`)', () => {
    const draft07Direct = zodToJsonSchema(StableSectionsSchema, {
      target: 'draft-07',
    }) as Record<string, unknown>;
    expect(DRAFT_07_URIS.has(String(draft07Direct.$schema))).toBe(true);

    const a = computePrefixFingerprint();
    const b = computePrefixFingerprint();
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
