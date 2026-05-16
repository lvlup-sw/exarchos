// ─── Quality-hint catalog (#1262) ────────────────────────────────────────────
//
// PR A2 / T03 — Output-token quality-hint catalog.
//
// A small, declarative table of hint *types* keyed by a stable identifier
// (e.g. `output_tokens_high`). Each entry describes:
//
//   - `verb` — the NextAction verb to surface to callers (currently
//     `checkpoint`; other verbs may be added as hints are introduced).
//   - `reasonTemplate` — a printf-style template populated by the projection
//     when it emits the hint. Tokens like `{tokens}` and `{threshold}` are
//     substituted at render time by the projection's hint-builder; the
//     catalog itself does no rendering.
//
// Keeping the catalog separate from the telemetry projection lets the
// verb/template evolve without touching the threshold-detection logic, and
// lets envelope-parity tests reason about hint payloads in isolation.

export interface QualityHintType {
  /** Stable identifier (snake_case). Used by the projection to look the hint up. */
  readonly id: string;
  /** NextAction verb to surface when the hint fires. */
  readonly verb: string;
  /**
   * Printf-style template populated at render time. Recognised tokens:
   *
   *   - `{tokens}` — the actual per-turn output-token sum that crossed.
   *   - `{threshold}` — the threshold value (in tokens) that was crossed.
   */
  readonly reasonTemplate: string;
}

const CATALOG: Readonly<Record<string, QualityHintType>> = Object.freeze({
  output_tokens_high: Object.freeze({
    id: 'output_tokens_high',
    verb: 'checkpoint',
    reasonTemplate:
      'Per-turn output tokens ({tokens}) crossed quality threshold ({threshold}); consider a checkpoint before continuing.',
  }),
});

/**
 * Return the registered quality-hint types keyed by their stable identifier.
 * The returned object is frozen — callers must treat it as readonly.
 */
export function getQualityHintTypes(): Readonly<Record<string, QualityHintType>> {
  return CATALOG;
}

/**
 * Look up a single quality-hint type by id. Returns `undefined` for unknown
 * ids so callers can branch on registration state without throwing.
 *
 * Guarded with `Object.hasOwn` so prototype-method names (`'toString'`,
 * `'hasOwnProperty'`, `'__proto__'`, etc.) cannot reach through into
 * `Object.prototype` and return a non-hint value. CodeRabbit F3 on
 * PR #1409 surfaced this — the catalog is a plain object literal, so a
 * bare `CATALOG[id]` lookup would otherwise hit inherited keys.
 */
export function getQualityHintType(id: string): QualityHintType | undefined {
  return Object.hasOwn(CATALOG, id) ? CATALOG[id] : undefined;
}

/**
 * Render a quality-hint's `reasonTemplate` into a human-readable string by
 * substituting `{token}` placeholders with the supplied values. Unknown
 * placeholders are left intact so the missing data is visible rather than
 * silently dropped.
 */
export function renderQualityHintReason(
  hint: QualityHintType,
  values: Readonly<Record<string, string | number>>,
): string {
  return hint.reasonTemplate.replace(/\{(\w+)\}/g, (match, key: string) => {
    const v = values[key];
    return v === undefined ? match : String(v);
  });
}
