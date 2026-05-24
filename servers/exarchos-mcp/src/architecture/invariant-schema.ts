/**
 * v3 invariant catalog schema + enforcement combinator DSL (issues: DR-1,
 * DR-2, DR-9, DR-10).
 *
 * This module defines the Zod source-of-truth for the v3 invariant catalog
 * entry shape. It is a strict superset of the v2 `InvariantEntry`
 * (`./invariants-loader.ts`): every v3 addition is optional, so a v2 entry
 * parses unchanged.
 *
 * Field keys mirror the YAML frontmatter, which is kebab-case
 * (`phase-affinity`, `cost-of-load`, …) — the schema keys match that
 * verbatim so a parsed frontmatter object validates without remapping.
 *
 * ## Contract seam (DR-10)
 *
 * Each top-level exported schema carries a `// contract-shaped: <Model>`
 * comment naming the `Strategos.Contracts` TypeSpec model it will be
 * generated from in a future milestone. Today these shapes are hand-written;
 * there is NO runtime dependency on Strategos.Contracts. The seam is verified
 * two ways: `contract-seam.ts` lints that every exported schema has the
 * comment, and `docs/architecture/invariants-v3-contract-seam.md` enumerates
 * the mapping.
 *
 * ## Sandbox guarantee (INV-4 / DR-2)
 *
 * Every object in the enforcement DSL is `.strict()`, so an unknown field
 * (e.g. an embedded `script`/`exec`/`code` key) fails validation. The DSL is
 * declarative-only: there is no escape hatch for user-supplied executable.
 */
import { z } from 'zod';

/**
 * Thrown at PARSE/LOAD time when a check leaf declares a `kind` that is not
 * one of the known leaf-execution kinds. Fail-closed (DR-9): an unknown kind
 * never reaches `evaluateTree`; it is rejected when the catalog is loaded.
 */
export class UnknownCheckKindError extends Error {
  readonly kind: unknown;
  constructor(kind: unknown) {
    super(
      `Unknown check kind '${String(kind)}'; must be one of ` +
        `${LEAF_KINDS.map((k) => `'${k}'`).join(', ')}`,
    );
    this.name = 'UnknownCheckKindError';
    this.kind = kind;
  }
}

/**
 * The leaf-execution vocabulary reused verbatim from
 * `../review/check-catalog.ts` (`CheckExecution`). The combinator DSL does
 * NOT invent new execution kinds — it only composes these.
 */
export const LEAF_KINDS = ['grep', 'structural', 'heuristic'] as const;
export type LeafKind = (typeof LEAF_KINDS)[number];

// ─── CheckNode (recursive combinator DSL) ───────────────────────────────────
// contract-shaped: CheckNode

/** Leaf check — a single grep / structural / heuristic execution. */
const CheckLeafSchema = z
  .object({
    kind: z.enum(LEAF_KINDS),
    pattern: z.string(),
    fileGlob: z.string().optional(),
    threshold: z.number().optional(),
  })
  .strict();

/**
 * Recursive combinator tree. Uses `z.lazy` so the `all-of` / `any-of` / `not`
 * / `scope` arms can reference `CheckNodeSchema` itself.
 *
 * Fail-closed (DR-9): before delegating to the union, a pre-check inspects
 * any object carrying a `kind` field. If `kind` is present but not a known
 * leaf kind, we throw `UnknownCheckKindError` at parse time rather than
 * letting Zod emit a generic union-mismatch error. This guarantees the
 * evaluator's exhaustive switch only ever receives a valid `LeafKind`.
 */
export const CheckNodeSchema: z.ZodType<CheckNode> = z.lazy(() =>
  z.preprocess((value) => {
    if (
      typeof value === 'object' &&
      value !== null &&
      'kind' in value &&
      !(LEAF_KINDS as readonly string[]).includes(
        (value as { kind: unknown }).kind as string,
      )
    ) {
      throw new UnknownCheckKindError((value as { kind: unknown }).kind);
    }
    return value;
  }, z.union([
    CheckLeafSchema,
    z.object({ 'all-of': z.array(CheckNodeSchema) }).strict(),
    z.object({ 'any-of': z.array(CheckNodeSchema) }).strict(),
    z.object({ not: CheckNodeSchema }).strict(),
    z
      .object({
        scope: z
          .object({
            fileGlob: z.string().optional(),
            phase: z.string().optional(),
          })
          .strict(),
        node: CheckNodeSchema,
      })
      .strict(),
  ])),
);

/**
 * Static TypeScript shape of the recursive combinator tree. Declared
 * explicitly (rather than inferred) because `z.lazy` cannot infer a
 * recursive type. Kept in lockstep with `CheckNodeSchema`.
 */
export type CheckLeaf = {
  kind: LeafKind;
  pattern: string;
  fileGlob?: string;
  threshold?: number;
};
export type CheckNode =
  | CheckLeaf
  | { 'all-of': CheckNode[] }
  | { 'any-of': CheckNode[] }
  | { not: CheckNode }
  | { scope: { fileGlob?: string; phase?: string }; node: CheckNode };

// ─── Enforcement (combinator DSL entry point) ───────────────────────────────
// contract-shaped: Enforcement

/**
 * Discriminated union on `mode`:
 *   - `check` — declarative combinator tree evaluated against a diff.
 *   - `audit` — an LLM audit prompt (no programmatic execution).
 */
export const EnforcementSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('check'), check: CheckNodeSchema }).strict(),
  z.object({ mode: z.literal('audit'), 'audit-prompt': z.string() }).strict(),
]);

export type Enforcement = z.infer<typeof EnforcementSchema>;

// ─── InvariantEntryV3 (catalog entry) ───────────────────────────────────────
// contract-shaped: InvariantEntry

const PHASE_VALUES = ['ideate', 'plan', 'delegate', 'review', 'synthesize'] as const;
const WORKFLOW_VALUES = ['feature', 'debug', 'refactor', 'discover', 'oneshot'] as const;
const SEVERITY_VALUES = ['blocking', 'advisory'] as const;
const INTEGRITY_CLASS_VALUES = ['substrate', 'sdlc', 'authoring', 'user'] as const;

/**
 * Per-context severity overrides. `default` always applies; `by-workflow` and
 * `by-phase` override it for a matching context.
 */
const SeveritySchema = z
  .object({
    default: z.enum(SEVERITY_VALUES),
    'by-workflow': z.record(z.string(), z.enum(SEVERITY_VALUES)).optional(),
    'by-phase': z.record(z.string(), z.enum(SEVERITY_VALUES)).optional(),
  })
  .strict();

/**
 * v3 catalog entry. Mirrors the v2 `InvariantEntry` required fields (kebab-case
 * frontmatter keys) and layers the optional v3 affinity / enforcement /
 * severity / integrity-class fields on top. All v3 additions are optional for
 * back-compat: a v2 entry parses with every v3 field `undefined`.
 *
 * NOTE: NOT `.strict()` at the entry level — unknown frontmatter keys are
 * tolerated (mirroring the v2 loader's forward-compat `raw` passthrough).
 * The `.strict()` boundary is the enforcement DSL, where unknown keys are a
 * security concern (INV-4).
 */
export const InvariantEntryV3Schema = z.object({
  // ── v2 required fields ──
  id: z.string().min(1),
  dimension: z.string(),
  axis: z.enum(['substrate', 'authoring']),
  'cost-of-load': z.enum(['always-load', 'reference-only', 'archivable']),
  'applies-to': z.array(z.string()),
  summary: z.string(),
  references: z.array(z.string()),
  // ── v2 optional fields ──
  citations: z.array(z.string()).optional(),
  'axiom-overlap': z.string().optional(),
  // ── v3 optional additions ──
  'phase-affinity': z.array(z.enum(PHASE_VALUES)).optional(),
  'workflow-affinity': z.array(z.enum(WORKFLOW_VALUES)).optional(),
  'state-affinity': z.array(z.string()).optional(),
  enforcement: EnforcementSchema.optional(),
  severity: SeveritySchema.optional(),
  'integrity-class': z.enum(INTEGRITY_CLASS_VALUES).optional(),
});

export type InvariantEntryV3 = z.infer<typeof InvariantEntryV3Schema>;
