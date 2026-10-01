/**
 * Audit-delivery closure audit. For each obligation in `audit-delivery-closure.data.ts`, it asks one question.
 * Does the payload field reach a reader that is told to act on it?
 * The presence of the field on the returned object proves nothing, because the field can exist while nothing reads it.
 * The audit checks two facts instead, and fails if either one is missing:
 *
 *   1. Contract: the registered `outputSchema` of the producing action declares the field and its enumerator
 *      as required, typed properties of the success-branch `data`. The audit reads the live Zod object.
 *   2. Instruction: one section of a declared reader document holds every required token.
 *      The tokens are the producing action, the field, the enumerator, and the re-entry action and parameter.
 *
 * The audit cannot prove that a reader obeyed the instruction. All policy is in the data file.
 */

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
 * Reads a reader document by its repo-relative path. It returns `undefined` when the document does not exist.
 * The audit reports that as a finding, not a skip, so a moved reader does not read as clean.
 */
export type ReadReaderFn = (repoRelativePath: string) => string | undefined;

/**
 * Finding codes:
 *  - `EMPTY_OBLIGATIONS`, `NO_READER_DECLARED`: the audit has no obligations, or an obligation has no reader.
 *  - `DECLARATION_NOT_FOUND`: no registered action matches the `declarationId`.
 *  - `UNREADABLE_CONTRACT`, `VACUOUS_CONTRACT`: no success-branch `data`, or a `data` that accepts every value.
 *  - `FIELD_NOT_IN_CONTRACT`, `FIELD_OPTIONAL_IN_CONTRACT`: `data` does not declare the property, or declares it optional.
 *  - `READER_MISSING`, `READER_EMPTY`: a declared reader document does not exist, or is empty.
 *  - `FIELD_NOT_MENTIONED`: the reader does not name the field.
 *  - `DIRECTIVE_NOT_COLOCATED`: the reader names every token, but no single section holds all of them.
 */
export type ClosureFindingCode =
  | 'EMPTY_OBLIGATIONS'
  | 'NO_READER_DECLARED'
  | 'DECLARATION_NOT_FOUND'
  | 'UNREADABLE_CONTRACT'
  | 'VACUOUS_CONTRACT'
  | 'FIELD_NOT_IN_CONTRACT'
  | 'FIELD_OPTIONAL_IN_CONTRACT'
  | 'READER_MISSING'
  | 'READER_EMPTY'
  | 'FIELD_NOT_MENTIONED'
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

/**
 * Splits a Markdown document into flat sections at ATX headings. A section runs to the next heading of any level.
 * With nested sections, a top-level section can hold the whole document. Then the co-location check is a whole-file grep.
 * A `#` line inside a fenced block is code, not a heading. The function is exported so that its test can call it directly.
 */
export function splitIntoSections(document: string): readonly string[] {
  const lines = document.split('\n');
  const sections: string[][] = [[]];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && /^#{1,6}\s/.test(line)) sections.push([]);
    const current = sections[sections.length - 1];
    if (current !== undefined) current.push(line);
  }
  return Object.freeze(sections.map((section) => section.join('\n')));
}

/**
 * True when one section of `document` holds every token in `tokens`.
 * An empty token list gives `false`, because a directive with no required tokens is evidence of nothing.
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

/**
 * What the live `outputSchema` says about one declared property.
 * `vacuous` means that `data` accepts every value. `unreadable` means that no success-branch `data` was found.
 */
export type ContractFieldState =
  | 'required'
  | 'optional'
  | 'absent'
  | 'vacuous'
  | 'unreadable';

/**
 * Inspects a registered `outputSchema` for one property of the success-branch `data`. It walks the Zod object, not the source text.
 * `withCappedShape` adds the capped-response fallback to `data` as a union, so one union member with the property is enough.
 * An `.optional()` property gives `optional`, because a reader cannot rely on a property that can be absent.
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
    if (field instanceof z.ZodOptional) {
      seen = 'optional';
      continue;
    }
    return 'required';
  }
  return seen;
}

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
 * Runs the closure audit. By default it uses the live obligations and the live {@link TOOL_REGISTRY}.
 * The test uses the options to pose a vacuous contract, or a reader that only calls the gate, without changes to the real data.
 * An empty obligation list is a finding, because an audit with no subject must not report clean.
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
 * Production reader loader. It finds the repo root from its own location, not from `process.cwd()`.
 * The repo root is two levels above `src/architecture/`. A wrong depth gives `READER_MISSING`, not a path error.
 */
function defaultReadReader(repoRelativePath: string): string | undefined {
  const url = new URL(`../../${repoRelativePath}`, import.meta.url);
  try {
    return readFileSync(fileURLToPath(url), 'utf8');
  } catch {
    return undefined;
  }
}

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
