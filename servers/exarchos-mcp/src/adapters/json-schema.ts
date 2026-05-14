import { z } from 'zod';

/**
 * Canonical `$schema` URI for JSON Schema draft-2020-12, the version that
 * MCP 2025-11-25 tool I/O schemas advertise. Exported so call-site tests can
 * compare against the same literal string that {@link zodToJsonSchema}
 * causes Zod v4 to stamp onto emitted schemas.
 */
export const JSON_SCHEMA_2020_12_URI = 'https://json-schema.org/draft/2020-12/schema';

/**
 * Wrapper around Zod v4's native `z.toJSONSchema` that defaults emitted
 * schemas to JSON Schema draft 2020-12.
 *
 * Why this exists
 * ---------------
 * The MCP 2025-11-25 spec defines tool `inputSchema` / `outputSchema` to
 * default to draft 2020-12. With Zod v4 we get this natively via
 * `z.toJSONSchema(schema, { target: 'draft-2020-12' })` — no more relabel
 * workaround. This wrapper IS the conformance chokepoint: contributors
 * cannot accidentally re-introduce another draft by adding a fresh
 * `import { toJSONSchema } from 'zod'`, because lint / review require the
 * adapter import instead. Treat any direct `z.toJSONSchema(...)` call site
 * outside this file as a violation.
 *
 * Behaviour
 * ---------
 * - Default call: `zodToJsonSchema(schema)` emits native draft-2020-12.
 * - Caller-supplied options pass through and may override `target`. If the
 *   caller passes a different `target` (e.g. `'draft-7'`), the upstream
 *   honours that choice; the wrapper does not stamp 2020-12 over the top.
 *
 * History
 * -------
 * Prior to PR-C (#1366) this wrapper round-tripped through `zod-to-json-schema`
 * with a manual `$schema` relabel because the legacy package never emitted
 * 2020-12. That workaround was removed when we bumped to zod v4 + MCP SDK
 * 1.29 (with a `patch-package` fix so the SDK threads `target: 'draft-2020-12'`
 * through `tools/list`). See
 * `docs/research/2026-05-13-zod-v4-decision-record-addendum.md`.
 */
export function zodToJsonSchema<T extends z.ZodType>(
  schema: T,
  opts?: Parameters<typeof z.toJSONSchema<T>>[1],
): ReturnType<typeof z.toJSONSchema<T>> {
  // Spread `opts` first, then re-assert `target` to the 2020-12 default if
  // the caller did not set it explicitly. Spreading after the default would
  // let `{ target: undefined }` overwrite the default with `undefined` and
  // silently fall back to the upstream library's behavior (CodeRabbit PR
  // #1369 minor — applies equally to the Zod v4 native rewrite here).
  return z.toJSONSchema<T>(schema, {
    ...opts,
    target: opts?.target ?? 'draft-2020-12',
  });
}
