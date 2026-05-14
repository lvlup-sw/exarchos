// ─── Envelope Schemas (Wave 0 — Carrier Swap) ───────────────────────────────
//
// Single-source-of-truth Zod schemas for the dispatch-core ⇄ carrier boundary
// (design `docs/designs/2026-05-13-wave-0-carrier-swap.md` §§2.1, 2.3, 2.5).
//
// Each schema is lifted from its companion TypeScript interface in
// `../format.ts` / `../next-action.ts`. The factory `EnvelopeSchema(dataSchema)`
// is the per-action contract surface; concrete handlers attach their `data`
// schema to produce the outputSchema MCP advertises for that tool action
// (DIM-1: dispatch core is single-source for action contracts).

import { NextAction as NextActionZ } from '../next-action.js';

/**
 * Zod schema for a single HATEOAS `next_actions[]` entry.
 *
 * Re-exported from `../next-action.ts` so the schemas module is the
 * single import site for the envelope surface, but the schema itself
 * stays defined in one place (its companion `NextAction` type is
 * `z.infer<typeof NextAction>` over there). Keeping a single Zod object
 * avoids drift between the canonical declaration and any envelope-local
 * copy.
 */
export const NextActionSchema = NextActionZ;
