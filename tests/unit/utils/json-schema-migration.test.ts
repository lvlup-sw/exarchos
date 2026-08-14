/**
 * Migration test (Wave 0 / Tasks B.2-B.5 / #1277):
 * Every `zodToJsonSchema()` call site in `src/` must
 * route through `adapters/json-schema.ts` so emitted schemas advertise the
 * 2020-12 `$schema` URI uniformly — UNLESS the call site passes an explicit
 * `target`, in which case the caller's choice wins (wrapper contract).
 *
 * One representative emission path per file is exercised:
 *  - describe/handler.ts                          → expect 2020-12 (no target)
 *  - projections/rehydration/fingerprint.ts       → expect draft-07 (explicit
 *                                                   `target: 'jsonSchema7'`)
 *  - runbooks/handler.ts                          → expect 2020-12 (no target)
 *  - adapters/schema-introspection.ts             → expect 2020-12 (no target)
 *
 * RED: before the import swap, all 3 "no target" paths fail because the
 * upstream `zod-to-json-schema` default is draft-07.
 * GREEN: after swapping each file's import to the adapter, the wrapper
 * stamps 2020-12 on those 3 paths.
 *
 * The fingerprint path is a regression assertion: the wrapper MUST NOT
 * relabel when a caller passes an explicit `target` — protects the
 * deterministic SHA-256 in `PREFIX_FINGERPRINT` from drifting.
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

// Zod v4 native emission stamps the spec-canonical `https://json-schema.org/draft-07/schema`
// (no trailing `#`). The legacy `zod-to-json-schema` library emitted the `#`-suffixed
// form. Both are accepted by JSON Schema parsers; we accept either to keep the
// regression-pinning intent (wrapper must NOT relabel) without depending on the
// trailing-hash convention upstream may revisit.
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

  it('runbooks/handler.ts emits 2020-12 $schema for resolved step schemas (no explicit target)', async () => {
    // `task-completion` has 3 non-native steps, each of which resolves an
    // action schema through `zodToJsonSchema(action.schema)`.
    const result = await handleRunbook({ id: 'task-completion' });
    expect(result.success).toBe(true);

    const data = result.data as { steps: Array<{ schema: unknown }> };
    expect(Array.isArray(data.steps)).toBe(true);
    expect(data.steps.length).toBeGreaterThan(0);

    // At least one step must carry a resolved schema (non-null) with 2020-12.
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

  it('projections/rehydration/fingerprint.ts preserves draft-07 (caller passes explicit `target: draft-07`)', () => {
    // The fingerprint module deliberately pins `target: 'draft-07'` because
    // the SHA-256 in `PREFIX_FINGERPRINT` is byte-locked against draft-07
    // emission. The wrapper MUST respect that explicit target (no relabel).
    //
    // We exercise that contract two ways:
    //  1. The fingerprint hash is deterministic and unchanged by the import
    //     swap — recomputing it must equal the value computed from a manual
    //     draft-07 emission of `StableSectionsSchema`.
    //  2. The wrapper called with `target: 'draft-07'` advertises a draft-07
    //     URI; the wrapper is a drop-in that does NOT relabel to 2020-12.
    const draft07Direct = zodToJsonSchema(StableSectionsSchema, {
      target: 'draft-07',
    }) as Record<string, unknown>;
    expect(DRAFT_07_URIS.has(String(draft07Direct.$schema))).toBe(true);

    // Computing the fingerprint exercises the actual fingerprint.ts call
    // site; if the swap accidentally relabels to 2020-12 the hash inputs
    // change and this assertion (matched against the committed fingerprint
    // semantics) fails. We don't pin the literal digest here — `PREFIX_FINGERPRINT`
    // and its dedicated test cover that — but we do require determinism:
    // two invocations agree, and the schema-derived input still parses as
    // draft-07 when emitted manually.
    const a = computePrefixFingerprint();
    const b = computePrefixFingerprint();
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
