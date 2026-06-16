// ─── mutation-adequacy — Stryker report schema + carrier aggregation ────────
//
// The adequacy backstop for the relaxed verification mix (verification-ladder
// slice 3, R5 / #1520). This module owns the REPORT region: an internal Zod
// schema mirroring Stryker's `mutation-testing-report-schema` — the de-facto
// cross-language mutation-report standard (Stryker JS/.NET, and the shape
// cargo-mutants / mutmut adapters normalize toward) — and a pure aggregator
// folding it into the fixed carrier the action returns (design §4.1, §4.6).
//
// Validation is internal Zod now; design §4.1 notes it becomes an MCP Resource
// when #1275 lands — never a tool, never a 5th visible surface (INV-5d). The
// action handler (task 003) consumes `parseMutationReport`; the dimension's
// `passed`/severity (task 006) reads `carrier.mutationScore`.
//
// Robustness contract (design §4.1 #4): a malformed or empty report degrades to
// a typed DEGRADE signal — `parseMutationReport` never throws. The handler maps
// that to a Warning carrier rather than failing the gate closed-with-an-error.
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';

// ─── Stryker mutation-testing-report-schema (subset we consume) ─────────────
//
// We model only the fields the aggregator and survivor-affordance mapping need;
// the report carries more (coverage maps, test files, framework metadata) that
// we deliberately ignore. `.passthrough()` keeps the unknown fields intact
// without constraining them, so a newer Stryker schemaVersion that adds fields
// still validates (forward-compatible) — we pin SHAPE, not EXHAUSTIVENESS.

/**
 * Mutant verdicts, per the Stryker schema's `MutantStatus`. `Killed` and
 * `Timeout` are "detected" (a test caught the mutation); `Survived` is the
 * adequacy gap; `NoCoverage` means no test exercised the mutated code at all.
 * The remaining statuses are unresolved verdicts (the mutant could not be run
 * to a clean kill/survive) — they count toward `total` but neither kills nor
 * survivors, so they depress the score without being affordance-actionable as a
 * "write a test that kills" target.
 */
export const MUTANT_STATUSES = [
  'Killed',
  'Survived',
  'NoCoverage',
  'Timeout',
  'CompileError',
  'RuntimeError',
  'Ignored',
  'Pending',
] as const;

export type MutantStatus = (typeof MUTANT_STATUSES)[number];

/** Statuses that count as a detected (killed) mutant for scoring. */
const KILLED_STATUSES: ReadonlySet<MutantStatus> = new Set<MutantStatus>(['Killed', 'Timeout']);

const PositionSchema = z.object({
  line: z.number().int().nonnegative(),
  column: z.number().int().nonnegative(),
});

const MutantLocationSchema = z.object({
  start: PositionSchema,
  end: PositionSchema,
});

export const MutantSchema = z
  .object({
    id: z.string(),
    mutatorName: z.string(),
    status: z.enum(MUTANT_STATUSES),
    location: MutantLocationSchema,
  })
  .passthrough();

export type Mutant = z.infer<typeof MutantSchema>;

export const FileResultSchema = z
  .object({
    language: z.string(),
    // `source` is optional in practice — some emitters omit it for diff-scoped
    // runs. The aggregator never reads it, so we keep it permissive.
    source: z.string().optional(),
    mutants: z.array(MutantSchema),
  })
  .passthrough();

export const MutationReportSchema = z
  .object({
    // schemaVersion is a string in the spec ('1', '1.0', …); accept any
    // non-empty string rather than pinning a value we'd have to chase.
    schemaVersion: z.string(),
    thresholds: z
      .object({ high: z.number(), low: z.number() })
      .passthrough()
      .optional(),
    files: z.record(z.string(), FileResultSchema),
  })
  .passthrough();

export type MutationReport = z.infer<typeof MutationReportSchema>;

// ─── Carrier ────────────────────────────────────────────────────────────────

/**
 * The fixed adequacy carrier (design §4.6). `mutationScore` follows the Stryker
 * convention: detected / (total − noCoverage). `total` counts every mutant with
 * a verdict; `noCoverage` is excluded from the denominator (uncovered code does
 * not lower the score for the tests that exist). The handler (task 003) wraps
 * this with `{ passed, report }` to form the full output-contract carrier.
 */
export interface MutationCarrier {
  readonly mutationScore: number;
  readonly killed: number;
  readonly survived: number;
  readonly noCoverage: number;
  readonly total: number;
}

/** Flatten every file's mutant list into one stream. */
function allMutants(report: MutationReport): readonly Mutant[] {
  return Object.values(report.files).flatMap((f) => f.mutants);
}

/**
 * Fold a validated report into the fixed carrier.
 *
 * `mutationScore = killed / (total − noCoverage)`, guarded so a zero
 * denominator (every mutant uncovered, or an empty report) yields 0 rather than
 * NaN — a NaN would silently poison the advisory-threshold comparison
 * downstream (task 006).
 */
export function aggregate(report: MutationReport): MutationCarrier {
  const mutants = allMutants(report);
  let killed = 0;
  let survived = 0;
  let noCoverage = 0;
  for (const m of mutants) {
    if (KILLED_STATUSES.has(m.status)) killed += 1;
    else if (m.status === 'Survived') survived += 1;
    else if (m.status === 'NoCoverage') noCoverage += 1;
  }
  const total = mutants.length;
  const denominator = total - noCoverage;
  const mutationScore = denominator > 0 ? killed / denominator : 0;
  return { mutationScore, killed, survived, noCoverage, total };
}

// ─── Fail-closed parse entry point ──────────────────────────────────────────

/**
 * Tagged result of {@link parseMutationReport}. A discriminated union so the
 * handler branches on `ok` without try/catch; the `reason` on the failure arm
 * is a human-readable degrade message surfaced as a Warning (never a throw).
 */
export type ParseResult =
  | { readonly ok: true; readonly report: MutationReport; readonly carrier: MutationCarrier }
  | { readonly ok: false; readonly reason: string };

/**
 * Parse a Stryker report (a JSON string from stdout/a report file, or an
 * already-parsed object) into the carrier, degrading to a typed signal on any
 * malformation. NEVER throws — empty input, non-JSON, or a shape that fails the
 * schema all return `{ ok: false, reason }`. This is the doctor-grade
 * robustness the action's #4 step depends on.
 */
export function parseMutationReport(input: unknown): ParseResult {
  let candidate: unknown = input;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      return { ok: false, reason: 'mutation report was empty' };
    }
    try {
      candidate = JSON.parse(trimmed);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `mutation report was not valid JSON: ${detail}` };
    }
  }

  const parsed = MutationReportSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join('.') || '(root)';
    const reason = `mutation report did not match the Stryker report schema at ${where}: ${
      issue?.message ?? 'unknown validation error'
    }`;
    return { ok: false, reason };
  }

  return { ok: true, report: parsed.data, carrier: aggregate(parsed.data) };
}
