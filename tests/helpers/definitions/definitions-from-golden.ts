/**
 * Projects the five built-in workflow definitions from the text of the golden.
 *
 * The kernel part of each definition is the lowered kernel of the golden. Each compound state of
 * the machine gives a group. Each transition gives an edge, and the admission IR edge at the same
 * index gives its category, its route and its obligation. The universal targets of the valid
 * targets give the universal list.
 *
 * The function reads only its argument. The golden recorded the code before the definition files
 * existed, so the projection and the files are two sources. The five files were printed once from
 * this projection.
 */

/** The route that is always legal. An edge with this route omits the `route` key. */
const ALWAYS_LEGAL_ROUTE = { kind: 'all', operands: [] };

/** The kernel keys in the order that a definition file prints them. Other kernel keys follow. */
const KERNEL_KEY_ORDER: readonly string[] = [
  'schemaVersion',
  'name',
  'steps',
  'transitions',
  'branchPoints',
  'loops',
  'forkPoints',
  'failureHandlers',
  'approvalPoints',
  'authority',
  'entryStepId',
];

/** The step keys in print order. */
const STEP_KEY_ORDER: readonly string[] = ['kind', 'stepId', 'stepName', 'isTerminal', 'runtime', 'stepType'];

/** The transition keys in print order. */
const TRANSITION_KEY_ORDER: readonly string[] = ['transitionId', 'fromStepId', 'toStepId', 'isDefault'];

/** The authority keys in the order of the built-in authority module. */
const AUTHORITY_KEY_ORDER: readonly string[] = [
  'invariants',
  'assumptions',
  'delegatedDecisions',
  'escalationBoundaries',
];

/** True when the value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns the value as an object, or throws with its path. */
function recordAt(value: unknown, at: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${at} is not an object`);
  return value;
}

/** Returns the value as a list, or throws with its path. */
function listAt(value: unknown, at: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${at} is not a list`);
  return value;
}

/** Returns the value as a string, or throws with its path. */
function textAt(value: unknown, at: string): string {
  if (typeof value !== 'string') throw new Error(`${at} is not a string`);
  return value;
}

/** Returns the value as a list of objects, or throws with the path of the first entry that is not an object. */
function recordsAt(value: unknown, at: string): readonly Record<string, unknown>[] {
  return listAt(value, at).map((entry, index) => recordAt(entry, `${at}.${index}`));
}

/** Returns a copy of an object with the listed keys first, in list order. The other keys follow in source order. */
function ordered(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.hasOwn(value, key)) copy[key] = value[key];
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!Object.hasOwn(copy, key)) copy[key] = entry;
  }
  return copy;
}

/** Returns an object with one key when the value is present, and an empty object when it is absent. */
function present(key: string, value: unknown): Record<string, unknown> {
  return value === undefined ? {} : { [key]: value };
}

/** True when two JSON values are equal. The key order of an object does not matter. */
function sameJson(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    const rightItems: readonly unknown[] = right;
    return left.every((item: unknown, index) => sameJson(item, rightItems[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]))
    );
  }
  return Object.is(left, right);
}

/** Returns the kernel part of a definition from the lowered kernel of the golden, in print order. */
function kernelPart(kernel: Record<string, unknown>, at: string): Record<string, unknown> {
  const steps = recordsAt(kernel.steps, `${at}.steps`).map((step) => ordered(step, STEP_KEY_ORDER));
  const transitions = recordsAt(kernel.transitions, `${at}.transitions`).map((transition) =>
    ordered(transition, TRANSITION_KEY_ORDER),
  );
  const authority = ordered(recordAt(kernel.authority, `${at}.authority`), AUTHORITY_KEY_ORDER);
  return ordered({ ...kernel, steps, transitions, authority }, KERNEL_KEY_ORDER);
}

/** Returns one group for each compound state of the machine. The members are the children of the state, in machine order. */
function groupsOf(states: readonly Record<string, unknown>[], at: string): Record<string, unknown>[] {
  return states
    .filter((state) => state.type === 'compound')
    .map((state) => {
      const groupId = textAt(state.id, `${at}.id`);
      return {
        groupId,
        members: states
          .filter((child) => child.parent === groupId)
          .map((child) => textAt(child.id, `${at}.${groupId}.child`)),
        initial: textAt(state.initial, `${at}.${groupId}.initial`),
        ...present('maxFixCycles', state.maxFixCycles),
        history: 'shallow',
        ...present('onEntry', state.onEntry),
        ...present('onExit', state.onExit),
      };
    });
}

/**
 * Returns the edges of one workflow, keyed by the kernel transition id. The machine transition, the
 * IR edge and the kernel transition at one index describe one edge.
 * @throws When the three lists differ in length, in their endpoints, or in the guard id.
 */
function edgesOf(
  machineTransitions: readonly Record<string, unknown>[],
  irEdges: readonly Record<string, unknown>[],
  kernelTransitions: readonly Record<string, unknown>[],
  at: string,
): Record<string, unknown> {
  if (machineTransitions.length !== irEdges.length || irEdges.length !== kernelTransitions.length) {
    throw new Error(`${at}: the machine, the IR and the kernel hold different numbers of transitions`);
  }
  const edges: Record<string, unknown> = {};
  kernelTransitions.forEach((kernelTransition, index) => {
    const transition = recordAt(machineTransitions[index], `${at}.${index}.machine`);
    const irEdge = recordAt(irEdges[index], `${at}.${index}.ir`);
    const endpoints = [
      [transition.from, irEdge.from, kernelTransition.fromStepId],
      [transition.to, irEdge.to, kernelTransition.toStepId],
    ];
    if (endpoints.some(([machine, ir, kernel]) => machine !== ir || ir !== kernel)) {
      throw new Error(`${at}.${index}: the machine, the IR and the kernel name different endpoints`);
    }
    const guardId = textAt(recordAt(transition.guard, `${at}.${index}.guard`).id, `${at}.${index}.guard.id`);
    if (irEdge.legacyGuardId !== guardId) {
      throw new Error(`${at}.${index}: the IR guard id is not the machine guard id '${guardId}'`);
    }
    edges[textAt(kernelTransition.transitionId, `${at}.${index}.transitionId`)] = {
      guardId,
      category: irEdge.category,
      ...present('route', sameJson(irEdge.route, ALWAYS_LEGAL_ROUTE) ? undefined : irEdge.route),
      obligation: irEdge.obligation,
      ...present('isFixCycle', transition.isFixCycle),
      ...present('isRevision', transition.isRevision),
      ...present('effects', transition.effects),
    };
  });
  return edges;
}

/**
 * Returns the universal edges from the valid targets. A universal target with no guard is the cancel
 * edge, and a universal target with a guard is the cleanup edge. The cancel edge comes first.
 * @throws When one kind of edge has two different targets or guards.
 */
function universalOf(validTargets: Record<string, unknown>, at: string): Record<string, unknown>[] {
  const byKind = new Map<string, Record<string, unknown>>();
  for (const [stateId, targets] of Object.entries(validTargets)) {
    for (const entry of recordsAt(targets, `${at}.${stateId}`)) {
      if (entry.universal !== true) continue;
      const to = textAt(entry.phase, `${at}.${stateId}.phase`);
      const edge =
        entry.guard === undefined
          ? { edgeKind: 'cancel', to }
          : { edgeKind: 'cleanup', to, guardId: textAt(recordAt(entry.guard, `${at}.${stateId}.guard`).id, 'guard.id') };
      const known = byKind.get(edge.edgeKind);
      if (known !== undefined && !sameJson(known, edge)) {
        throw new Error(`${at}.${stateId}: the ${edge.edgeKind} edge has two forms`);
      }
      byKind.set(edge.edgeKind, edge);
    }
  }
  return ['cancel', 'cleanup'].flatMap((kind) => {
    const edge = byKind.get(kind);
    return edge === undefined ? [] : [edge];
  });
}

/**
 * Returns the definition of each built-in workflow type of the golden, in golden order.
 * Each definition is the kernel part with one more key, `exarchos`.
 * @throws When the golden text does not have the shape that the renderer of the golden writes.
 */
export function definitionsFromGolden(goldenText: string): Readonly<Record<string, Record<string, unknown>>> {
  const workflows = recordAt(recordAt(JSON.parse(goldenText), 'golden').workflows, 'workflows');
  const definitions: Record<string, Record<string, unknown>> = {};
  for (const [type, entry] of Object.entries(workflows)) {
    const at = `workflows.${type}`;
    const workflow = recordAt(entry, at);
    const kernel = recordAt(JSON.parse(textAt(workflow.kernel, `${at}.kernel`)), `${at}.kernel`);
    const machine = recordAt(JSON.parse(textAt(workflow.machine, `${at}.machine`)), `${at}.machine`);
    const states = Object.entries(recordAt(machine.states, `${at}.machine.states`)).map(([id, state]) =>
      recordAt(state, `${at}.machine.states.${id}`),
    );
    definitions[type] = {
      ...kernelPart(kernel, `${at}.kernel`),
      exarchos: {
        extensionVersion: '1',
        groups: groupsOf(states, `${at}.machine.states`),
        edges: edgesOf(
          recordsAt(machine.transitions, `${at}.machine.transitions`),
          recordsAt(workflow.irEdges, `${at}.irEdges`),
          recordsAt(kernel.transitions, `${at}.kernel.transitions`),
          `${at}.edges`,
        ),
        universal: universalOf(recordAt(workflow.validTargets, `${at}.validTargets`), `${at}.validTargets`),
      },
    };
  }
  return definitions;
}
