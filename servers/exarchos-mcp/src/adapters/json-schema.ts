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
 * currently defaults to draft-07 and (as of v3.25.1) only accepts the
 * targets `'jsonSchema7' | 'jsonSchema2019-09' | 'openApi3' | 'openAi'`
 * — none of which directly emits the 2020-12 `$schema` marker.
 *
 * Routing every call site through this wrapper makes the conformance bar
 * deterministic: contributors cannot accidentally re-introduce draft-07
 * by adding a fresh `import { zodToJsonSchema } from 'zod-to-json-schema'`
 * — lint rules / review can require the adapter import instead.
 *
 * Behaviour
 * ---------
 * - Default call: `zodToJsonSchema(schema)` requests the
 *   `'jsonSchema2019-09'` upstream target (the closest available draft) and
 *   then overwrites `$schema` with the canonical 2020-12 URI. 2019-09 and
 *   2020-12 share the same structural surface for the constructs we emit,
 *   so re-labelling is safe; when upstream gains a true 2020-12 target this
 *   stamp can be dropped.
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
