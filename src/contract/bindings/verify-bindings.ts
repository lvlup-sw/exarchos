/**
 * The pre-startup binding gate. It compares the contract ActionIds with the implementation-binding
 * table and returns a typed verdict. The MCP bootstrap calls `assertBindingsAtStartup`, so a bad
 * binding stops startup and not the first tool call.
 *
 * The four violation kinds:
 * - `missing`: a contract ActionId whose tool has no valid binding.
 * - `duplicate`: more than one binding for the same tool.
 * - `stale`: a binding for a tool that no contract ActionId uses.
 * - `non-function`: a binding whose handler is not a function, such as a JSON copy.
 */

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
  /** The offending ActionId for a `missing` violation. It is `null` for a tool-level fault. */
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
 * Verifies that each ActionId in `contract` resolves to exactly one binding in `table` whose
 * handler is a function. The function is pure and returns a verdict. It does not throw.
 * Duplicate counts include invalid bindings, because any second claim on a tool is ambiguous.
 */
export function verifyBindings(
  contract: BindingContract,
  table: readonly ImplementationBinding[],
): BindingVerdict {
  const violations: BindingViolation[] = [];

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
 * The pre-startup gate that the MCP bootstrap calls. It derives the contract ActionIds from the
 * live registry in memory and verifies them against the binding table. On any violation it throws,
 * before the server registers a tool.
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
