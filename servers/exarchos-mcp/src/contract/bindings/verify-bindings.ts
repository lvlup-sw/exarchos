// ─── Pre-startup binding verification (P03-04) ───────────────────────────────
//
// PROGRAM-03, API-004. Exit proof: "missing, duplicate, or stale bindings fail
// BEFORE server startup." This module is that gate. It reconciles the contract's
// ActionIds (the registration manifest generated from the compiled contract)
// against the implementation-binding table (the real composite-handler loaders)
// and returns a typed verdict; the MCP bootstrap calls `assertBindingsAtStartup`
// and REFUSES TO START on any violation — never deferring the failure to the
// first tool call.
//
// Four fail-closed violation modes:
//   • missing      — a contract ActionId whose tool has no bound handler.
//   • duplicate    — two bindings claiming the same tool (ambiguous handler).
//   • stale        — a binding for a tool that no ActionId in the contract uses.
//   • non-function — a "binding" whose handler is not a function (a serializable
//                    stand-in that was forged / round-tripped through JSON).
//
// Composes with the P03-01 authority freeze: the compiled contract this checks
// against is only emitted once `verifyContractAuthority()` is green (the compiler
// gates on it), so a blocked authority already halts generation upstream and a
// missing/stale binding halts the wire projection here.
// ────────────────────────────────────────────────────────────────────────────

import {
  BINDING_TABLE,
  isImplementationBinding,
  type ImplementationBinding,
} from './binding-table.js';
import {
  deriveRegistrationFromRegistry,
  registrationActionRefs,
  type RegistrationActionRef,
} from './generate-registration.js';

/** The kinds of fail-closed binding violation. */
export const BINDING_VIOLATION_KINDS = ['missing', 'duplicate', 'stale', 'non-function'] as const;
export type BindingViolationKind = (typeof BINDING_VIOLATION_KINDS)[number];

export interface BindingViolation {
  readonly kind: BindingViolationKind;
  /** The offending tool (`<null>` only when a forged binding has no tool). */
  readonly tool: string;
  /** The offending ActionId for a `missing` violation; `null` for tool-level faults. */
  readonly actionId: string | null;
  readonly message: string;
}

export interface BindingVerdict {
  readonly ok: boolean;
  readonly violations: readonly BindingViolation[];
  /** A human-readable, deterministic summary (green light or the violation list). */
  readonly report: string;
}

/** The contract shape verification consumes — the `{ actionId, tool }` set. */
export interface BindingContract {
  readonly descriptors: readonly RegistrationActionRef[];
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function sortViolations(violations: readonly BindingViolation[]): BindingViolation[] {
  const key = (v: BindingViolation): string =>
    `${v.kind}\u0000${v.tool}\u0000${v.actionId ?? ''}\u0000${v.message}`;
  return [...violations].sort((a, b) => byString(key(a), key(b)));
}

/**
 * Verify that every ActionId in `contract` resolves to EXACTLY ONE non-
 * serializable handler binding in `table`. Pure and total: returns a verdict,
 * never throws. `ok === true` is the pre-startup green light.
 */
export function verifyBindings(
  contract: BindingContract,
  table: readonly ImplementationBinding[],
): BindingVerdict {
  const violations: BindingViolation[] = [];

  // 1. Validate each binding is a real, non-serializable holder, and count
  //    bindings per tool (a valid binding requires a function `load`).
  const validCountByTool = new Map<string, number>();
  const totalCountByTool = new Map<string, number>();
  const boundTools = new Set<string>();
  table.forEach((binding, index) => {
    const rawTool =
      binding !== null && typeof binding === 'object' && typeof binding.tool === 'string'
        ? binding.tool
        : `<binding[${index}]>`;
    totalCountByTool.set(rawTool, (totalCountByTool.get(rawTool) ?? 0) + 1);

    if (!isImplementationBinding(binding)) {
      violations.push({
        kind: 'non-function',
        tool: rawTool,
        actionId: null,
        message:
          `binding for tool '${rawTool}' is not a non-serializable implementation binding ` +
          `(its handler is not a function — a serializable stand-in cannot be a binding)`,
      });
      return;
    }
    validCountByTool.set(binding.tool, (validCountByTool.get(binding.tool) ?? 0) + 1);
    boundTools.add(binding.tool);
  });

  // 2. Duplicate — a tool claimed by more than one binding is an ambiguous
  //    handler (which of the two would serve the ActionId?).
  for (const [tool, count] of totalCountByTool) {
    if (count > 1) {
      violations.push({
        kind: 'duplicate',
        tool,
        actionId: null,
        message: `tool '${tool}' has ${count} bindings — exactly one implementation binding is required`,
      });
    }
  }

  // 3. Missing — a contract ActionId whose tool has no VALID binding.
  const contractTools = new Set<string>();
  for (const ref of contract.descriptors) {
    contractTools.add(ref.tool);
    if ((validCountByTool.get(ref.tool) ?? 0) === 0) {
      violations.push({
        kind: 'missing',
        tool: ref.tool,
        actionId: ref.actionId,
        message: `ActionId '${ref.actionId}' has no implementation binding for tool '${ref.tool}'`,
      });
    }
  }

  // 4. Stale — a binding for a tool no ActionId in the contract uses.
  for (const tool of boundTools) {
    if (!contractTools.has(tool)) {
      violations.push({
        kind: 'stale',
        tool,
        actionId: null,
        message: `binding for tool '${tool}' is stale — no ActionId in the contract uses it`,
      });
    }
  }

  const sorted = sortViolations(violations);
  const ok = sorted.length === 0;
  const report = ok
    ? `bindings OK — ${contractTools.size} tool(s), ${contract.descriptors.length} ActionId(s) each bound to exactly one non-serializable handler`
    : `binding verification FAILED — ${sorted.length} violation(s):\n` +
      sorted.map((v) => `  [${v.kind}] ${v.tool}${v.actionId ? ` ${v.actionId}` : ''}: ${v.message}`).join('\n');

  return { ok, violations: sorted, report };
}

/** Thrown when the pre-startup binding gate fails — refuses server startup. */
export class BindingVerificationError extends Error {
  readonly verdict: BindingVerdict;
  constructor(verdict: BindingVerdict) {
    super(verdict.report);
    this.name = 'BindingVerificationError';
    this.verdict = verdict;
  }
}

/**
 * The pre-startup gate the MCP bootstrap calls. Derives the contract's ActionId
 * set from the live registry (the fast, in-memory path — no filesystem I/O),
 * verifies it against the real binding table, and THROWS on any violation so a
 * missing/duplicate/stale/non-function binding halts BEFORE the server registers
 * a single tool (never at first invocation).
 */
export function assertBindingsAtStartup(
  table: readonly ImplementationBinding[] = BINDING_TABLE,
): BindingVerdict {
  const contract: BindingContract = {
    descriptors: registrationActionRefs(deriveRegistrationFromRegistry()),
  };
  const verdict = verifyBindings(contract, table);
  if (!verdict.ok) throw new BindingVerificationError(verdict);
  return verdict;
}
