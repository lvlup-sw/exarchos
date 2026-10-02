/**
 * The catalog of quality-hint types, keyed by a stable id such as `output_tokens_high`.
 *
 * Each entry gives the NextAction `verb` and a `reasonTemplate`. The telemetry
 * projection fills the `{tokens}` and `{threshold}` placeholders with
 * {@link renderQualityHintReason} when it emits the hint. The catalog is separate
 * from the threshold logic, so tests can examine hint payloads alone.
 */

export interface QualityHintType {
  /** Stable identifier (snake_case). Used by the projection to look the hint up. */
  readonly id: string;
  /** NextAction verb to surface when the hint fires. */
  readonly verb: string;
  /**
   * Template for the reason text. `{tokens}` is the per-turn output-token sum, and
   * `{threshold}` is the threshold in tokens that the sum crossed.
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
 * Returns the quality-hint type for `id`, or `undefined` for an unknown id.
 * The `Object.hasOwn` check stops a name such as `'toString'` or `'__proto__'`
 * from returning an inherited value of `Object.prototype`.
 */
export function getQualityHintType(id: string): QualityHintType | undefined {
  return Object.hasOwn(CATALOG, id) ? CATALOG[id] : undefined;
}

/**
 * Replaces each `{token}` placeholder in `reasonTemplate` with its value. An
 * unknown placeholder stays in the text, so the missing data is visible.
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
