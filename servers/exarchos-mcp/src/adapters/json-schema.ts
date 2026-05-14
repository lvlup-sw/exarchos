import type { z } from 'zod';
import {
  zodToJsonSchema as upstream,
  type Options as UpstreamOptions,
  type Targets as UpstreamTargets,
} from 'zod-to-json-schema';

/**
 * Canonical JSON Schema draft 2020-12 `$schema` URL.
 *
 * Per the MCP spec (2025-11-25), tool `inputSchema` and `outputSchema`
 * default to draft 2020-12 when no explicit schema is supplied.
 */
export const JSON_SCHEMA_2020_12_URI =
  'https://json-schema.org/draft/2020-12/schema';

/**
 * Wrapper around `zodToJsonSchema` that defaults emitted schemas to
 * JSON Schema draft 2020-12.
 *
 * Why this exists
 * ---------------
 * The MCP 2025-11-25 spec defines tool `inputSchema` / `outputSchema` to
 * default to draft 2020-12. The upstream `zod-to-json-schema` package
 * currently defaults to draft-07 and only accepts the targets
 * `'jsonSchema7' | 'jsonSchema2019-09' | 'openApi3' | 'openAi'` — none of
 * which directly emits the 2020-12 `$schema` marker.
 *
 * Routing every call site through this wrapper makes the conformance bar
 * deterministic: contributors cannot accidentally re-introduce draft-07
 * by adding a fresh `import { zodToJsonSchema } from 'zod-to-json-schema'`
 * — lint rules / review can require the adapter import instead.
 *
 * Why a relabel and not a real 2020-12 emission
 * ---------------------------------------------
 * `zod-to-json-schema@3.25.2` is the FINAL release of that package — the
 * v3.25.0 changelog states "v4 now supports JSON schema natively" and the
 * project is effectively archived. No 2020-12 target is coming.
 *
 * `@modelcontextprotocol/sdk@1.26.x` has its own internal Zod → JSON Schema
 * converter (`zod-json-schema-compat.ts`), but the routing splits on Zod
 * major: a Zod-v4 input takes the `z4mini.toJSONSchema(target: 'draft-2020-12')`
 * path and emits true 2020-12; a Zod-v3 input falls through to the same
 * archived `zodToJsonSchema` and emits draft-07 (the SDK silently drops
 * any `target` hint on this branch). Exarchos pins Zod v3, so the SDK
 * itself can only emit draft-07 today.
 *
 * Of our 10 call sites, only the 2 that flow through `registerTool`/
 * `tools/list` are even reachable by the SDK's converter. The other 8
 * (describe handlers, fingerprint, runbooks, schema introspection) are
 * internal emission paths the SDK never touches. So no path to true
 * 2020-12 exists without migrating the MCP server to Zod v4 — a much
 * larger change than this wave can absorb. Tracked at #1366.
 *
 * Behaviour
 * ---------
 * - Default call: `zodToJsonSchema(schema)` requests the
 *   `'jsonSchema2019-09'` upstream target (the closest available draft) and
 *   then overwrites `$schema` with the canonical 2020-12 URI. 2019-09 and
 *   2020-12 share the same structural surface for the constructs Zod emits
 *   (objects, properties, required, enums, oneOf, const, $ref) — there is
 *   no Zod construct in the codebase that would produce 2019-09-only
 *   syntax (e.g. `unevaluatedProperties`). Re-labelling is therefore safe
 *   for all current emission. When upstream gains a true 2020-12 target,
 *   or when Zod is migrated to v4, this stamp drops.
 * - Caller-supplied options pass through and may override `target`. If the
 *   caller passes a different `target`, the wrapper does NOT stamp 2020-12
 *   — the caller's explicit choice wins.
 *
 * Per design `docs/designs/2026-05-13-wave-0-carrier-swap.md` §2.6 and
 * issue #1277.
 */
export function zodToJsonSchema(
  schema: z.ZodTypeAny,
  opts?: Partial<UpstreamOptions<UpstreamTargets>>,
): ReturnType<typeof upstream> {
  const callerOverrodeTarget =
    opts !== undefined && Object.prototype.hasOwnProperty.call(opts, 'target');

  const merged: Partial<UpstreamOptions<UpstreamTargets>> = {
    target: 'jsonSchema2019-09',
    ...(opts ?? {}),
  };

  const result = upstream(
    schema,
    merged as Partial<UpstreamOptions<UpstreamTargets>>,
  ) as Record<string, unknown>;

  if (!callerOverrodeTarget) {
    result.$schema = JSON_SCHEMA_2020_12_URI;
  }

  return result as ReturnType<typeof upstream>;
}
