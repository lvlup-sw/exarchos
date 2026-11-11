/**
 * RESERVED(issue: #1927, owner: exarchos, expires: 2026-12-31)
 * No production module imports this module yet. The definition registry becomes its first importer.
 *
 * The rules of a user workflow definition, a file that a repository holds beside its code.
 *
 * A user file passes the shape rules of the built-in files under the prefix `user`, and eight user
 * rules. Together they close each optional key of the kernel and of the extension. Only the
 * `category` of an edge stays open. A later reader opens a rule when it gives a key a meaning.
 */

import { ExarchosCapsuleAuthorityV1Schema } from '../../contract/capsule/exarchos-capsule.js';
import { FACT_DECLARATION } from '../admission/built-in-workflow-ir.js';
import { tryCompileEdgeCondition } from '../admission/edge-condition.js';
import { edgeShapeFindings, isBuiltInDefinitionType, shapeFindings } from './built-in.js';
import { checkDefinitionDocument, StepIdSchema, type DefinitionFinding } from './extension.js';

/** The key of the extension in a definition document. */
const EXTENSION_KEY = 'exarchos';

/** The rule prefix of the shape rules of a user file. */
const USER_PREFIX = 'user';

/** The name of a user type: lowercase kebab case, the rule of a custom type of the server config. */
const KEBAB_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The bound of a stable id of the capsule. Each task of a capsule holds its step id as a stable id. */
const STEP_ID_MAX_LENGTH = 256;

/** The edge keys that no reader of a user type reads. */
const EDGE_FLAG_KEYS: readonly string[] = ['effects', 'isFixCycle', 'isRevision'];

/** True when the value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns the value as a list, or an empty list when it is not a list. */
function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Returns the value as an object, or an empty object when it is not an object. */
function recordOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/**
 * The `user-name` rule. The name is lowercase kebab case and is not a built-in type. It is not an
 * own key of `Object.prototype`, because a per-type table gives a function for such a key.
 */
function nameFindings(document: Record<string, unknown>): DefinitionFinding[] {
  const { name } = document;
  const valid =
    typeof name === 'string' &&
    KEBAB_NAME.test(name) &&
    !isBuiltInDefinitionType(name) &&
    !Object.hasOwn(Object.prototype, name);
  return valid ? [] : [{ rule: 'user-name', path: ['name'] }];
}

/**
 * The `user-step-id` rule. Each step id matches the step-id pattern of the extension and holds at most
 * 256 characters. So each step id is a stable id of the capsule.
 */
function stepIdFindings(document: Record<string, unknown>): DefinitionFinding[] {
  return listOf(document.steps).flatMap((step, index) => {
    const stepId = recordOf(step).stepId;
    const valid =
      typeof stepId === 'string' && stepId.length <= STEP_ID_MAX_LENGTH && StepIdSchema.safeParse(stepId).success;
    return valid ? [] : [{ rule: 'user-step-id', path: ['steps', index, 'stepId'] }];
  });
}

/** The `user-authority` rule. The authority parses with the authority schema of the capsule, which refuses an empty category. */
function authorityFindings(document: Record<string, unknown>): DefinitionFinding[] {
  return ExarchosCapsuleAuthorityV1Schema.safeParse(document.authority).success
    ? []
    : [{ rule: 'user-authority', path: ['authority'] }];
}

/** The `user-edge-flags` rule. No edge holds `effects`, `isFixCycle` or `isRevision`. */
function edgeFlagFindings(edges: Record<string, unknown>): DefinitionFinding[] {
  return Object.entries(edges).flatMap(([transitionId, edge]) =>
    EDGE_FLAG_KEYS.filter((key) => Object.hasOwn(recordOf(edge), key)).map((key) => ({
      rule: 'user-edge-flags',
      path: [EXTENSION_KEY, 'edges', transitionId, key],
    })),
  );
}

/** The `user-groups` rule. The group list is empty. */
function groupFindings(extension: Record<string, unknown>): DefinitionFinding[] {
  return listOf(extension.groups).length === 0 ? [] : [{ rule: 'user-groups', path: [EXTENSION_KEY, 'groups'] }];
}

/** The `user-universal` rule. No universal entry holds a guard id, so only a `cancel` entry passes. */
function universalFindings(extension: Record<string, unknown>): DefinitionFinding[] {
  return listOf(extension.universal).flatMap((entry, index) =>
    Object.hasOwn(recordOf(entry), 'guardId')
      ? [{ rule: 'user-universal', path: [EXTENSION_KEY, 'universal', index, 'guardId'] }]
      : [],
  );
}

/**
 * The `user-condition` rule. Each route and each gate or approval presence compiles against the
 * shared fact vocabulary. So a condition over an undeclared fact or event gives a finding at its path.
 */
function conditionFindings(edges: Record<string, unknown>): DefinitionFinding[] {
  const findings: DefinitionFinding[] = [];
  for (const [transitionId, edge] of Object.entries(edges)) {
    const at = [EXTENSION_KEY, 'edges', transitionId];
    const { route, obligation } = recordOf(edge);
    const { presence } = recordOf(obligation);
    if (route !== undefined && !tryCompileEdgeCondition(route, FACT_DECLARATION).ok) {
      findings.push({ rule: 'user-condition', path: [...at, 'route'] });
    }
    if (presence !== undefined && !tryCompileEdgeCondition(presence, FACT_DECLARATION).ok) {
      findings.push({ rule: 'user-condition', path: [...at, 'obligation', 'presence'] });
    }
  }
  return findings;
}

/**
 * Runs the user rules over one raw definition document and returns every finding, in rule order.
 * The rules run in this order: the name, the shape rules, the step ids and the authority. Then come
 * the edges, the edge flags, the groups, the universal edges and the conditions.
 */
export function validateUserDefinition(raw: unknown): readonly DefinitionFinding[] {
  const document = recordOf(raw);
  const extension = recordOf(document[EXTENSION_KEY]);
  const edges = recordOf(extension.edges);
  return [
    ...nameFindings(document),
    ...shapeFindings(raw, USER_PREFIX),
    ...stepIdFindings(document),
    ...authorityFindings(document),
    ...edgeShapeFindings(raw, USER_PREFIX, 'refused'),
    ...edgeFlagFindings(edges),
    ...groupFindings(extension),
    ...universalFindings(extension),
    ...conditionFindings(edges),
  ];
}

/** Checks one raw user document on the one check path, with the user rules as its own rules. */
export function checkUserDefinition(raw: unknown): ReturnType<typeof checkDefinitionDocument> {
  return checkDefinitionDocument(raw, validateUserDefinition);
}
