// ─── Audit-delivery closure audit (DR-4/DR-24, task 069) ────────────────────
//
// Answers ONE question per obligation declared in `audit-delivery-closure.data.ts`:
// does the payload field reach a reader that is INSTRUCTED TO ACT ON IT?
//
// ── The property this measures, and the proxy it refuses ────────────────────
// "The field is present on the returned object" is the proxy. It was TRUE for
// `auditPrompt` throughout the period when nothing read it, so it cannot
// distinguish a delivered prompt from a stranded one. This module measures two
// structural facts instead, and fails if either is missing:
//
//   1. CONTRACT — the producing action's registered `outputSchema` declares the
//      field and its enumerator as REQUIRED, TYPED properties of the
//      success-branch `data`. Read off the live Zod object, not off source text:
//      a named binding launders a grep, which is the same reason the vacuity
//      census walks the schema rather than the file.
//   2. INSTRUCTION — a declared reader document carries, INSIDE A SINGLE
//      SECTION, every token the obligation derives: the producing action, the
//      field, the enumerator, and the re-entry action + parameter. The
//      single-section requirement is what separates an instruction from a
//      coincidence — a document that mentions `check_review_verdict` in one
//      place and `auditPrompt` in a footnote three sections away has not told
//      anybody to do anything.
//
// Neither fact alone is sufficient, and that is the point of checking both from
// one record: wiring a reader to an untyped contract gives the reader nothing to
// rely on, and typing a contract nobody reads gives the payload nowhere to go.
//
// ── What it does NOT claim ──────────────────────────────────────────────────
// It cannot prove a reader OBEYED the instruction — no repo-local mechanism can
// observe an agent's judgment. What it proves is that the instruction exists, is
// co-located, names a re-entry seam that actually accepts the judgment, and
// stays bound to the field's real name in the real contract. When any of those
// four decays, this reddens. That is a strictly stronger floor than "the field
// is present", which is the floor task 069 found.
//
// POLICY IS DATA: every rule lives in `audit-delivery-closure.data.ts`. This
// module enumerates, reads and reports. It decides nothing.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { TOOL_REGISTRY } from '../registry.js';
import { extractEnvelopeDataSchema } from '../verbs/worktree/schemas.js';
import {
  AUDIT_DELIVERY_OBLIGATIONS,
  requiredDirectiveTokens,
  type AuditDeliveryObligation,
} from './audit-delivery-closure.data.js';

// ─── Inputs ─────────────────────────────────────────────────────────────────

/** Minimal shape of a registered action this audit needs. */
export interface ClosureAction {
  readonly name: string;
  readonly outputSchema: z.ZodType;
}

/** Minimal shape of a composite tool this audit needs. */
export interface ClosureTool {
  readonly name: string;
  readonly actions: readonly ClosureAction[];
}

/**
 * Reads a reader document by its repo-relative path.
 *
 * Returns `undefined` when the document does not exist — which is a FINDING, not
 * a skip. A reader that moved is exactly the failure this must not read as
 * clean.
 */
export type ReadReaderFn = (repoRelativePath: string) => string | undefined;

// ─── Findings ───────────────────────────────────────────────────────────────

export type ClosureFindingCode =
  /** Zero obligations declared — the audit has no subject (non-empty denominator). */
  | 'EMPTY_OBLIGATIONS'
  /** An obligation names zero reader documents (non-empty denominator, per record). */
  | 'NO_READER_DECLARED'
  /** The obligation's `declarationId` matches no action in the registry. */
  | 'DECLARATION_NOT_FOUND'
  /** The action's `outputSchema` has no readable success-branch `data`. */
  | 'UNREADABLE_CONTRACT'
  /** The success-branch `data` accepts every value — the vacuity DR-4 removes. */
  | 'VACUOUS_CONTRACT'
  /** `data` does not declare the field (or the enumerator) at all. */
  | 'FIELD_NOT_IN_CONTRACT'
  /** `data` declares it, but optionally — a reader cannot rely on it. */
  | 'FIELD_OPTIONAL_IN_CONTRACT'
  /** A declared reader document does not exist. */
  | 'READER_MISSING'
  /** A declared reader document is empty — an empty doc instructs nobody. */
  | 'READER_EMPTY'
  /** The reader never names the delivered field. */
  | 'FIELD_NOT_MENTIONED'
  /**
   * The reader names every required token, but never all of them inside one
   * section — scattered mentions, not an instruction.
   */
  | 'DIRECTIVE_NOT_COLOCATED';

export interface ClosureFinding {
  readonly code: ClosureFindingCode;
  /** The obligation this finding belongs to (`''` for corpus-level findings). */
  readonly obligationId: string;
  /** The reader path, when the finding is about one. */
  readonly reader?: string | undefined;
  readonly message: string;
}

export interface AuditDeliveryClosureReport {
  readonly ok: boolean;
  /** How many obligations were evaluated — the denominator, reported not implied. */
  readonly obligationCount: number;
  /** How many reader documents were scanned across all obligations. */
  readonly readerCount: number;
  /** Obligation ids whose contract half and instruction half both hold. */
  readonly closed: readonly string[];
  readonly findings: readonly ClosureFinding[];
}

// ─── Section splitting ──────────────────────────────────────────────────────

/**
 * Split a Markdown document into sections at ATX headings.
 *
 * A heading opens a new section; everything up to the next heading of ANY level
 * belongs to it. Deliberately flat rather than nested: nesting would let a
 * top-level heading's section swallow the whole document, which would make the
 * co-location requirement equivalent to a whole-file grep and defeat the point.
 *
 * Exported so the co-located test can drive it directly — the co-location rule
 * is the load-bearing half of the instruction check, and a rule proven only
 * through its caller has been proven about the caller.
 */
export function splitIntoSections(document: string): readonly string[] {
  const lines = document.split('\n');
  const sections: string[][] = [[]];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    // A `#` inside a fenced block is code, not a heading.
    if (!inFence && /^#{1,6}\s/.test(line)) sections.push([]);
    const current = sections[sections.length - 1];
    if (current !== undefined) current.push(line);
  }
  return Object.freeze(sections.map((section) => section.join('\n')));
}

/**
 * Does any single section of `document` contain every token in `tokens`?
 *
 * An empty token list would answer `true` for any document, so it answers
 * `false` instead: a directive with no required tokens is not satisfiable
 * evidence of anything (non-empty denominator, pushed into the pure predicate
 * rather than left to the caller).
 */
export function hasColocatedDirective(
  document: string,
  tokens: readonly string[],
): boolean {
  if (tokens.length === 0) return false;
  return splitIntoSections(document).some((section) =>
    tokens.every((token) => section.includes(token)),
  );
}

// ─── Contract inspection ────────────────────────────────────────────────────

/** What the live `outputSchema` says about one declared property. */
export type ContractFieldState =
  | 'required'
  | 'optional'
  | 'absent'
  /** `data` accepts every value — every property is "present" and none is typed. */
  | 'vacuous'
  /** No success-branch `data` could be located at all. */
  | 'unreadable';

/**
 * Inspect a registered `outputSchema` for one success-branch `data` property.
 *
 * Walks the Zod object, never the source text: `withCappedShape` unions the
 * capped-response fallback into `data`, so the live shape is a union whose
 * FIRST member is the action's own payload. The union is unwrapped by requiring
 * the property on at least one member and treating the capped fallback (which
 * declares none of these fields) as the tolerated alternative — the same
 * "do NOT over-constrain" discipline the schemas themselves follow.
 */
export function inspectContractField(
  outputSchema: z.ZodType,
  property: string,
): ContractFieldState {
  const data = extractEnvelopeDataSchema(outputSchema);
  if (data === undefined) return 'unreadable';
  if (data instanceof z.ZodUnknown || data instanceof z.ZodAny) return 'vacuous';

  const candidates = data instanceof z.ZodUnion ? data.options : [data];
  let seen: ContractFieldState = 'absent';
  for (const candidate of candidates) {
    if (!(candidate instanceof z.ZodObject)) continue;
    const shape: Record<string, unknown> = candidate.shape;
    const field = shape[property];
    if (!(field instanceof z.ZodType)) continue;
    // `.optional()` is a wrapper; a reader told to iterate a field cannot rely
    // on one that may be absent, so optionality is reported, not accepted.
    if (field instanceof z.ZodOptional) {
      seen = 'optional';
      continue;
    }
    return 'required';
  }
  return seen;
}

// ─── The audit ──────────────────────────────────────────────────────────────

export interface ClosureAuditOptions {
  readonly obligations?: readonly AuditDeliveryObligation[];
  readonly tools?: readonly ClosureTool[];
  readonly readReader?: ReadReaderFn;
}

function findAction(
  tools: readonly ClosureTool[],
  declarationId: string,
): ClosureAction | undefined {
  for (const tool of tools) {
    for (const action of tool.actions) {
      if (`${tool.name}.${action.name}` === declarationId) return action;
    }
  }
  return undefined;
}

/**
 * Run the closure audit.
 *
 * Defaults to the LIVE obligations and the LIVE {@link TOOL_REGISTRY}; the
 * options are the seam the co-located self-test drives to pose the pre-069 world
 * (a vacuous contract, a reader that only invokes the gate) without editing the
 * real ones. A guard proven only through its seams has been proven about its
 * seams, so the self-test also asserts the live defaults.
 */
export function auditDeliveryClosure(
  options: ClosureAuditOptions = {},
): AuditDeliveryClosureReport {
  const obligations = options.obligations ?? AUDIT_DELIVERY_OBLIGATIONS;
  const tools = options.tools ?? TOOL_REGISTRY;
  const readReader = options.readReader ?? defaultReadReader;

  const findings: ClosureFinding[] = [];
  const closed: string[] = [];
  let readerCount = 0;

  // Non-empty denominator. An audit over zero obligations proves nothing and
  // must not report clean — that failure mode reads green precisely when the
  // instrument has lost its subject.
  if (obligations.length === 0) {
    findings.push({
      code: 'EMPTY_OBLIGATIONS',
      obligationId: '',
      message:
        'Audit-delivery closure enumerated ZERO obligations. An empty denominator ' +
        'is not a clean audit — check that audit-delivery-closure.data.ts still ' +
        'resolves and still declares obligations.',
    });
  }

  for (const obligation of obligations) {
    const before = findings.length;
    const action = findAction(tools, obligation.declarationId);

    if (action === undefined) {
      findings.push({
        code: 'DECLARATION_NOT_FOUND',
        obligationId: obligation.id,
        message:
          `No registered action matches '${obligation.declarationId}'. The producer ` +
          `moved or was renamed; the obligation is stranded.`,
      });
    } else {
      for (const property of [obligation.field, obligation.enumerator]) {
        const state = inspectContractField(action.outputSchema, property);
        if (state === 'required') continue;
        findings.push({
          code: contractFindingCode(state),
          obligationId: obligation.id,
          message:
            `'${obligation.declarationId}' does not declare '${property}' as a ` +
            `required, typed property of its success-branch data (state: ${state}). ` +
            `A reader instructed to act on it could not rely on its presence or ` +
            `shape. Declare the action with withCappedShape(<typed envelope>).`,
        });
      }
    }

    if (obligation.readers.length === 0) {
      findings.push({
        code: 'NO_READER_DECLARED',
        obligationId: obligation.id,
        message:
          `Obligation '${obligation.id}' names ZERO reader documents. A delivery ` +
          `obligation with no reader is the defect it exists to detect, wearing ` +
          `the shape of a passing check.`,
      });
    }

    const tokens = requiredDirectiveTokens(obligation);
    for (const reader of obligation.readers) {
      readerCount += 1;
      const body = readReader(reader);
      if (body === undefined) {
        findings.push({
          code: 'READER_MISSING',
          obligationId: obligation.id,
          reader,
          message: `Declared reader '${reader}' does not exist.`,
        });
        continue;
      }
      if (body.trim() === '') {
        findings.push({
          code: 'READER_EMPTY',
          obligationId: obligation.id,
          reader,
          message: `Declared reader '${reader}' is empty; an empty document instructs nobody.`,
        });
        continue;
      }
      if (!body.includes(obligation.field)) {
        findings.push({
          code: 'FIELD_NOT_MENTIONED',
          obligationId: obligation.id,
          reader,
          message:
            `'${reader}' never names '${obligation.field}'. Invoking ` +
            `'${obligation.actionName}' is not the same as being told to act on what ` +
            `it returns — expected: ${obligation.expectation}.`,
        });
        continue;
      }
      if (!hasColocatedDirective(body, tokens)) {
        findings.push({
          code: 'DIRECTIVE_NOT_COLOCATED',
          obligationId: obligation.id,
          reader,
          message:
            `'${reader}' mentions '${obligation.field}' but no single section of it ` +
            `carries the whole instruction (${tokens.join(', ')}). Scattered mentions ` +
            `are not a directive — expected: ${obligation.expectation}.`,
        });
      }
    }

    if (findings.length === before) closed.push(obligation.id);
  }

  return Object.freeze({
    ok: findings.length === 0,
    obligationCount: obligations.length,
    readerCount,
    closed: Object.freeze(closed),
    findings: Object.freeze(findings),
  });
}

function contractFindingCode(state: ContractFieldState): ClosureFindingCode {
  if (state === 'unreadable') return 'UNREADABLE_CONTRACT';
  if (state === 'vacuous') return 'VACUOUS_CONTRACT';
  if (state === 'optional') return 'FIELD_OPTIONAL_IN_CONTRACT';
  return 'FIELD_NOT_IN_CONTRACT';
}

/**
 * The production reader loader: resolve a repo-relative path against the repo
 * root, which this module locates from its OWN location rather than from
 * `process.cwd()` (a cwd-relative resolve reads a different tree depending on
 * where the runner was launched).
 */
function defaultReadReader(repoRelativePath: string): string | undefined {
  // `src/architecture/<file>` → repo root is two levels up. It was four while
  // this module lived inside `servers/exarchos-mcp/`; the fold removed those
  // two segments. An over-deep walk still names a real directory, so it
  // surfaces as "declared reader does not exist" rather than as a path error.
  const url = new URL(`../../${repoRelativePath}`, import.meta.url);
  try {
    return readFileSync(fileURLToPath(url), 'utf8');
  } catch {
    return undefined;
  }
}

// ─── Reporting ──────────────────────────────────────────────────────────────

/** Render the report for a CI log: the count against its denominator, then every finding. */
export function formatDeliveryClosureReport(
  report: AuditDeliveryClosureReport,
): string {
  const head =
    `audit-delivery closure — ${report.closed.length} closed of ` +
    `${report.obligationCount} obligation(s) across ${report.readerCount} reader(s)`;
  if (report.ok) return `${head}. OK.`;
  const lines = report.findings.map(
    (f) => `  [${f.code}] ${f.obligationId}${f.reader === undefined ? '' : ` (${f.reader})`}: ${f.message}`,
  );
  return [`${head}; ${report.findings.length} finding(s):`, ...lines].join('\n');
}
