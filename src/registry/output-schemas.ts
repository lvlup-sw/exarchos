import { EnvelopeSchema } from '../contract/schemas/envelope.js';
import { z } from 'zod';

// ─── Output Schemas — `_meta.deprecation` Registration (DR-11, #1259) ──────
//
// The HSM single-path consolidation introduces a deprecation envelope on
// the affected actions. `_meta.deprecation` describes the migration window
// (since/removeIn) and the canonical replacement so agents can self-correct
// without human prompting. The schemas below describe the typed sub-shape
// registered in each action's `outputSchema`.
//
// v2.10 registered the same typed sub-shape on both
// `exarchos_workflow.set` and `exarchos_workflow.transition`. v2.11 (DR-4)
// removes the `set` action entry from the registry, but keeps the
// `_meta.deprecation` slot on `transition`'s `outputSchema` for one more
// release as a historical marker (INV-5b). v2.12 drops the slot.
// `WorkflowSetOutputSchema` is retained as a private export for one
// release to preserve symmetry of the schema definitions; nothing in the
// registry references it any longer.
//
// The envelope version is implicitly bumped via this schema registration:
// `_meta.envelopeVersion` callers can rely on the structured deprecation
// payload appearing instead of (or alongside) any free-text warning that
// may have surfaced via `result.warnings` historically.

/**
 * `_meta.deprecation` typed sub-shape (DR-4, DR-11). Surfaces on the response
 * envelope of any action whose handler routes through a deprecation rerouting
 * surface (currently: `exarchos_workflow.set` when `phase` is provided).
 *
 * `since` / `removeIn` use semver strings (validated as non-empty);
 * `replacement` names the canonical action a caller should migrate to.
 */
export const MetaDeprecationSchema = z.object({
  since: z.string().min(1).describe('Version when this action was deprecated (semver)'),
  removeIn: z.string().min(1).describe('Version when this action is removed (semver)'),
  replacement: z.string().min(1).describe('Canonical action name that supersedes this one'),
});

// Wave 0 / Task G.2 (#1340): consolidate the three v2.10.0-preview.2
// standalone envelope constants onto the canonical `EnvelopeSchema(data)`
// factory from `contract/schemas/envelope.ts`. Each surface remains as a named
// export so any downstream consumer that typed-imported the constants
// directly continues to compile through one release window; canonical
// replacement is `EnvelopeSchema` itself (callers should migrate to it
// before the v2.12 removal).
//
// Per design §2.1 (single envelope factory) and DIM-1 (dispatch core is
// single-source for action contracts) — the previous bespoke
// `z.object({...}).passthrough()` shapes drifted from the canonical
// envelope contract (no typed `_perf`, `success` not literal-discriminated,
// no typed `error` block). The factory anchors all three on the same
// discriminated-union envelope and applies an additional intersection
// constraint where DR-4/DR-11 requires the typed `_meta.deprecation`
// sub-shape.

/**
 * Shape constraint for `_meta.deprecation` (DR-4, DR-11). When `_meta`
 * carries a `deprecation` slot, each sub-field must validate against
 * {@link MetaDeprecationSchema}. The slot itself is always optional —
 * the canonical action does not emit it; the rerouted/deprecated
 * surface does.
 *
 * `passthrough()` on `_meta` so the rest of the typed envelope's
 * `z.record(z.string(), z.unknown())` _meta merge survives the
 * intersection.
 */
const MetaDeprecationConstraint = z.object({
  _meta: z.object({
    deprecation: MetaDeprecationSchema.optional(),
  }).passthrough().optional(),
}).passthrough();

/**
 * `outputSchema` for the (now-removed) `exarchos_workflow.set` action.
 *
 * @deprecated v2.10 LCD; will be removed in v2.12. Use
 * `EnvelopeSchema(dataSchema)` from `./schemas/envelope.js` directly.
 *
 * Retained for one release as a named re-export so downstream typed
 * imports compile. Nothing in the registry references this constant
 * any longer (the `set` action entry was removed in v2.11/DR-4).
 */
export const WorkflowSetOutputSchema = EnvelopeSchema(z.unknown()).and(
  MetaDeprecationConstraint,
);

/**
 * `outputSchema` for `exarchos_workflow.transition` (DR-11).
 *
 * @deprecated v2.10 LCD; will be removed in v2.12. Use
 * `EnvelopeSchema(dataSchema)` from `./schemas/envelope.js` directly
 * (parameterized on the action's success-data shape).
 *
 * Thin wrapper over the canonical envelope factory plus the DR-4/DR-11
 * typed `_meta.deprecation` constraint. The canonical action does not
 * emit `_meta.deprecation` itself, but registering the typed sub-shape
 * keeps the surfaces interchangeable from a contract-introspection
 * standpoint (INV-5b).
 */
export const WorkflowTransitionOutputSchema = EnvelopeSchema(z.unknown()).and(
  MetaDeprecationConstraint,
);

/**
 * `outputSchema` for `exarchos_workflow.update` (Wave 0, #1340 prep for
 * #1266).
 *
 * @deprecated v2.10 LCD; will be removed in v2.12. Use
 * `EnvelopeSchema(dataSchema)` from `./schemas/envelope.js` directly.
 *
 * Mirrors {@link WorkflowTransitionOutputSchema} EXCEPT the
 * `_meta.deprecation` constraint: `update` is a canonical surface
 * restored in v2.10.0-preview.2 and is not on a deprecation track, so
 * the envelope does not advertise the migration sub-shape.
 */
export const WorkflowUpdateOutputSchema = EnvelopeSchema(z.unknown());

/**
 * `outputSchema` for `exarchos_view.telemetry` (PR3/T10, #1364 — Wave 3
 * polish on top of Wave 0 carrier swap).
 *
 * Typed envelope so MCP advertises the per-tool `actionErrors` and
 * `actionErrorBreakdown` fields the `tool.action_errored` projection now
 * folds. Both fields are required on every tool entry so downstream
 * consumers (CLI rendering, dashboards, drift detection) can rely on
 * their presence rather than treating them as optional decorators.
 *
 * The per-tool entry is intentionally `.passthrough()` because the
 * compact-vs-full split adds extra arrays (`durations`, `sizes`,
 * `tokenEstimates`) on the non-compact path — strict objects would
 * reject the full shape. `hints[]` items are also passthrough to leave
 * room for future hint flavours without re-cutting the schema.
 *
 * See [`docs/designs/archive/2026-05-15-wave2-wave3-polish.md`](../docs/designs/archive/2026-05-15-wave2-wave3-polish.md)
 * `#1364 — split transport vs action-level errors` for context.
 */
const TelemetryToolEntrySchema = z.object({
  tool: z.string(),
  invocations: z.number().nonnegative(),
  errors: z.number().nonnegative(),
  totalDurationMs: z.number().nonnegative(),
  totalBytes: z.number().nonnegative(),
  totalTokens: z.number().nonnegative(),
  p50DurationMs: z.number().nonnegative(),
  p95DurationMs: z.number().nonnegative(),
  p50Bytes: z.number().nonnegative(),
  p95Bytes: z.number().nonnegative(),
  p50Tokens: z.number().nonnegative(),
  p95Tokens: z.number().nonnegative(),
  // PR3/T10 (#1364) — structured action-level failure counters.
  actionErrors: z.number().nonnegative(),
  actionErrorBreakdown: z.record(z.string(), z.number().nonnegative()),
}).passthrough();

const TelemetryViewDataSchema = z.object({
  session: z.object({
    start: z.string(),
    totalInvocations: z.number().nonnegative(),
    totalTokens: z.number().nonnegative(),
  }),
  tools: z.array(TelemetryToolEntrySchema),
  hints: z.array(z.unknown()),
}).passthrough();

export const TelemetryViewOutputSchema = EnvelopeSchema(TelemetryViewDataSchema);

// ─── Capped-shape outputSchema union (DR-1/DR-3/DR-8, Task 022) ───────────────
//
// DR-4 (task 055) moved `CappedDataSchema` and `withCappedShape` into
// `output-schema-declaration.ts`, where the `DeclaredOutputSchema` brand they
// mint is defined. The brand's minting function is module-private there, which
// is what makes `withCappedShape` the SOLE constructor of a substantive
// `outputSchema` instead of merely the conventional one. Both are re-exported
// from this module so their long-standing import path (`./registry.js`) keeps
// working for the economy-enforcement and contract-compiler consumers.
export { CappedDataSchema, withCappedShape } from '../output-schema-declaration.js';
