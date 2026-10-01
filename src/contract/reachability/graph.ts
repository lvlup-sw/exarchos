/**
 * The pure closure model of the reachability graph. Closure means that each public action has
 * exactly one complete path from its authored ActionId to its packaged fixture.
 *
 * The hops are `schema`, `route`, `handler`, `owner`, `output`, `artifact`, `fixture`, and
 * `event`. The `owner` hop applies only to a mutating action, and the `event` hop only to an
 * action that declares emissions. A missing hop or an ambiguous hop is a closure failure that
 * names the action and the hop.
 *
 * This core takes materialized inputs, so tests need no filesystem. `collect.ts` reads the real
 * inputs from the live authorities.
 */

import { digestText } from '../authority-digest.js';
import { canonicalJson } from '../request-context.js';

/** The ordered reachability hops from authored ActionId to packaged fixture. */
export const REACHABILITY_HOPS = [
  'schema',
  'route',
  'handler',
  'owner',
  'output',
  'artifact',
  'fixture',
  'event',
] as const;
export type ReachabilityHop = (typeof REACHABILITY_HOPS)[number];

/**
 * The class of authority that each hop resolves against. The closure denominator comes from the
 * contract compile, so a hop that reads the same compile resolves for every action and can never fail.
 *
 * Thus no hop is `self`. A `runtime` hop reads the wiring that the server runs. A
 * `shipped-artifact` hop reads a checked-in artifact from a different generation pass.
 * `kill-fixtures.test.ts` breaks the real authority of each hop and expects the census to drop.
 */
export const HOP_AUTHORITIES: Readonly<Record<ReachabilityHop, 'runtime' | 'shipped-artifact'>> =
  Object.freeze({
    schema: 'shipped-artifact',
    route: 'runtime',
    handler: 'runtime',
    owner: 'runtime',
    output: 'shipped-artifact',
    artifact: 'shipped-artifact',
    fixture: 'shipped-artifact',
    /**
     * Resolves against `EVENT_ANNOTATIONS`, the event catalog. The declared emissions feed the
     * compile, so a read from the compiled contract is a `self` read.
     */
    event: 'runtime',
  });

/** Resolution status of one hop for one action. */
export type HopStatus = 'ok' | 'missing' | 'ambiguous' | 'not-applicable';

/** An authored public action. It is the origin node of the graph. */
export interface ActionNode {
  readonly actionId: string;
  readonly tool: string;
  readonly action: string;
  /** True when the effect policy of the action mutates. Then the `owner` hop applies. */
  readonly mutates: boolean;
}

/** The shipped input and output schema of a compiled action, from the proof-fixture baseline. */
export interface SchemaEntry {
  readonly actionId: string;
}

/** A routing arm in the shipped composite router that serves the ActionId. */
export interface RouteEntry {
  readonly actionId: string;
  readonly tool: string;
}

/** A tool bound to an implementation handler. */
export interface HandlerEntry {
  readonly tool: string;
}

/** The effect owner of a tool, from the provider map. */
export interface OwnerEntry {
  readonly tool: string;
  readonly owner: string;
}

/**
 * One event that an action declares it emits. An emission that is not in `EVENT_ANNOTATIONS`
 * is a dangling reference. There is no `consumed` flag, because `consumedBy` is a non-empty
 * tuple by type, and a check on it cannot fail.
 */
export interface EmissionEntry {
  readonly actionId: string;
  readonly event: string;
  /** The event has a registration in the live catalog. */
  readonly registered: boolean;
}

/** The output contract of the action: its output kinds and error codes. */
export interface OutputEntry {
  readonly actionId: string;
  readonly outputKinds: readonly string[];
  readonly errorCodes: readonly string[];
}

/** The shipped client surface has a command for the action. */
export interface ArtifactEntry {
  readonly actionId: string;
}

/** The fixture of the action is in the checked-in proof-fixture baseline. */
export interface FixtureEntry {
  readonly actionId: string;
}

/**
 * A known unclosed action and hop, with a reason. A break at that hop does not count as a
 * closure failure. If the action is closed at that hop, the exception is stale.
 */
export interface ClosureException {
  readonly actionId: string;
  readonly hop: ReachabilityHop;
  readonly reason: string;
}

/** The fully-materialized graph inputs the pure core consumes. */
export interface ReachabilityInputs {
  readonly surfaceVersion: string;
  readonly actions: readonly ActionNode[];
  readonly schemas: readonly SchemaEntry[];
  readonly routes: readonly RouteEntry[];
  readonly handlers: readonly HandlerEntry[];
  readonly owners: readonly OwnerEntry[];
  readonly outputs: readonly OutputEntry[];
  readonly artifacts: readonly ArtifactEntry[];
  readonly fixtures: readonly FixtureEntry[];
  readonly emissions: readonly EmissionEntry[];
  /** The governed closure exceptions. */
  readonly exceptions?: readonly ClosureException[];
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** One hop's resolution for one action. */
export interface HopResolution {
  readonly hop: ReachabilityHop;
  readonly applicable: boolean;
  readonly resolverCount: number;
  readonly status: HopStatus;
}

function statusFor(applicable: boolean, count: number): HopStatus {
  if (!applicable) return 'not-applicable';
  if (count === 0) return 'missing';
  if (count > 1) return 'ambiguous';
  return 'ok';
}

/**
 * Counts the resolvers of each hop for one action, in the fixed hop order. `handler` and `owner`
 * resolve by tool, so a duplicate binding for the tool is `ambiguous`. A route counts only
 * under the tool of the action.
 *
 * `owner` applies only to a mutating action. Both emission hops apply only to an action that
 * declares emissions. The `event` hop resolves only when the catalog registers every declared event.
 */
export function resolveHops(action: ActionNode, inputs: ReachabilityInputs): readonly HopResolution[] {
  const schemaCount = inputs.schemas.filter((s) => s.actionId === action.actionId).length;
  const routeCount = inputs.routes.filter(
    (r) => r.actionId === action.actionId && r.tool === action.tool,
  ).length;
  const handlerCount = inputs.handlers.filter((h) => h.tool === action.tool).length;
  const ownerCount = inputs.owners.filter((o) => o.tool === action.tool).length;
  const outputCount = inputs.outputs.filter(
    (o) => o.actionId === action.actionId && o.outputKinds.length > 0 && o.errorCodes.length > 0,
  ).length;
  const artifactCount = inputs.artifacts.filter((a) => a.actionId === action.actionId).length;
  const fixtureCount = inputs.fixtures.filter((f) => f.actionId === action.actionId).length;

  const emitted = inputs.emissions.filter((e) => e.actionId === action.actionId);
  const emits = emitted.length > 0;
  const eventCount = emits && emitted.every((e) => e.registered) ? 1 : 0;

  const counts: Record<ReachabilityHop, { applicable: boolean; count: number }> = {
    schema: { applicable: true, count: schemaCount },
    route: { applicable: true, count: routeCount },
    handler: { applicable: true, count: handlerCount },
    owner: { applicable: action.mutates, count: ownerCount },
    output: { applicable: true, count: outputCount },
    artifact: { applicable: true, count: artifactCount },
    fixture: { applicable: true, count: fixtureCount },
    event: { applicable: emits, count: eventCount },
  };

  return REACHABILITY_HOPS.map((hop): HopResolution => {
    const { applicable, count } = counts[hop];
    return { hop, applicable, resolverCount: count, status: statusFor(applicable, count) };
  });
}

/** The closure verdict of one action: is there exactly one complete path? */
export interface ActionClosure {
  readonly actionId: string;
  readonly tool: string;
  readonly mutates: boolean;
  readonly closed: boolean;
  readonly hops: readonly HopResolution[];
}

/** A closure failure that names the action and the broken hop. */
export interface ClosureDiagnostic {
  readonly actionId: string;
  readonly hop: ReachabilityHop;
  readonly kind: 'missing' | 'ambiguous' | 'stale-exception';
  readonly message: string;
}

export interface ClosureReport {
  readonly ok: boolean;
  readonly totalActions: number;
  readonly closedActions: number;
  readonly actions: readonly ActionClosure[];
  readonly diagnostics: readonly ClosureDiagnostic[];
  /** The governed exceptions that matched a real break. */
  readonly honouredExceptions: readonly ClosureException[];
}

function diagnosticMessage(action: ActionNode, res: HopResolution): string {
  const target =
    res.hop === 'handler' || res.hop === 'owner' ? `tool '${action.tool}'` : `ActionId '${action.actionId}'`;
  if (res.status === 'missing') {
    return `ActionId '${action.actionId}' has no ${res.hop} — the reachability path breaks at the ${res.hop} hop (${target} resolves to 0)`;
  }
  return `ActionId '${action.actionId}' has ${res.resolverCount} ${res.hop} resolvers — the ${res.hop} hop is AMBIGUOUS (${target}); exactly one complete path is required`;
}

/**
 * Evaluates closure over the materialized inputs. An action is closed when each applicable hop
 * resolves to exactly one. A `missing` or `ambiguous` hop gives a diagnostic that names the action and the hop.
 *
 * A listed exception that matches a real break is honoured and gives no diagnostic. A listed
 * exception with no break gives a `stale-exception` diagnostic.
 */
export function evaluateClosure(inputs: ReachabilityInputs): ClosureReport {
  const exceptions = inputs.exceptions ?? [];
  const exceptionKey = (actionId: string, hop: ReachabilityHop): string => `${actionId}\u0000${hop}`;
  const exceptionByKey = new Map<string, ClosureException>();
  for (const exc of exceptions) exceptionByKey.set(exceptionKey(exc.actionId, exc.hop), exc);
  const usedExceptions = new Set<string>();

  const diagnostics: ClosureDiagnostic[] = [];
  const actions: ActionClosure[] = [];

  const sortedActions = [...inputs.actions].sort((a, b) => byString(a.actionId, b.actionId));
  for (const action of sortedActions) {
    const hops = resolveHops(action, inputs);
    let closed = true;
    for (const res of hops) {
      if (res.status === 'ok' || res.status === 'not-applicable') continue;
      const key = exceptionKey(action.actionId, res.hop);
      const excepted = exceptionByKey.get(key);
      if (excepted) {
        usedExceptions.add(key);
        continue;
      }
      closed = false;
      diagnostics.push({
        actionId: action.actionId,
        hop: res.hop,
        kind: res.status === 'missing' ? 'missing' : 'ambiguous',
        message: diagnosticMessage(action, res),
      });
    }
    actions.push({
      actionId: action.actionId,
      tool: action.tool,
      mutates: action.mutates,
      closed,
      hops,
    });
  }

  for (const exc of exceptions) {
    if (!usedExceptions.has(exceptionKey(exc.actionId, exc.hop))) {
      diagnostics.push({
        actionId: exc.actionId,
        hop: exc.hop,
        kind: 'stale-exception',
        message:
          `governed closure exception for ActionId '${exc.actionId}' at the ${exc.hop} hop is STALE ` +
          `— the action is fully closed there (reason on file: "${exc.reason}"). Remove the exception.`,
      });
    }
  }

  const honoured = exceptions.filter((exc) => usedExceptions.has(exceptionKey(exc.actionId, exc.hop)));
  diagnostics.sort((a, b) =>
    byString(`${a.actionId}\u0000${a.hop}\u0000${a.kind}`, `${b.actionId}\u0000${b.hop}\u0000${b.kind}`),
  );

  return {
    ok: diagnostics.length === 0,
    totalActions: actions.length,
    closedActions: actions.filter((a) => a.closed).length,
    actions,
    diagnostics,
    honouredExceptions: honoured,
  };
}

/** The current reachability-graph artifact schema version. */
export const REACHABILITY_GRAPH_VERSION = 1 as const;

/** The ordered hop chain of one action in the serialized graph. */
export interface GraphHop {
  readonly hop: ReachabilityHop;
  readonly status: HopStatus;
  readonly resolverCount: number;
}

/** The compact path of one action through the graph. */
export interface GraphActionPath {
  readonly actionId: string;
  readonly tool: string;
  readonly mutates: boolean;
  readonly closed: boolean;
  readonly hops: readonly GraphHop[];
}

export interface GraphSummary {
  readonly totalActions: number;
  readonly closedActions: number;
  readonly fullyClosed: boolean;
  readonly mutatingActions: number;
  readonly exceptionCount: number;
}

export interface ReachabilityGraph {
  readonly graphVersion: typeof REACHABILITY_GRAPH_VERSION;
  readonly surfaceVersion: string;
  readonly hops: readonly ReachabilityHop[];
  readonly actions: readonly GraphActionPath[];
  readonly exceptions: readonly ClosureException[];
  readonly summary: GraphSummary;
  /** The `sha256:` digest of the canonical graph body, without this field. */
  readonly contentDigest: string;
}

/**
 * Builds the reachability graph from the materialized inputs. Actions are sorted by ActionId,
 * hops keep the fixed order, and the digest covers canonical JSON. Thus the same inputs give the same bytes.
 */
export function buildReachabilityGraph(inputs: ReachabilityInputs): ReachabilityGraph {
  const report = evaluateClosure(inputs);
  const actions: GraphActionPath[] = report.actions.map((a) => ({
    actionId: a.actionId,
    tool: a.tool,
    mutates: a.mutates,
    closed: a.closed,
    hops: a.hops.map((h) => ({ hop: h.hop, status: h.status, resolverCount: h.resolverCount })),
  }));
  const exceptions = [...(inputs.exceptions ?? [])].sort((x, y) =>
    byString(`${x.actionId}\u0000${x.hop}`, `${y.actionId}\u0000${y.hop}`),
  );
  const summary: GraphSummary = {
    totalActions: report.totalActions,
    closedActions: report.closedActions,
    fullyClosed: report.closedActions === report.totalActions && report.ok,
    mutatingActions: actions.filter((a) => a.mutates).length,
    exceptionCount: exceptions.length,
  };
  const body = {
    graphVersion: REACHABILITY_GRAPH_VERSION,
    surfaceVersion: inputs.surfaceVersion,
    hops: [...REACHABILITY_HOPS],
    actions,
    exceptions,
    summary,
  };
  return { ...body, contentDigest: digestText(canonicalJson(body)) };
}

/** The canonical serialization of the graph, with a trailing newline. */
export function serializeReachabilityGraph(graph: ReachabilityGraph): string {
  return canonicalJson(graph) + '\n';
}

export interface GraphNode {
  /** The stable node id: `${actionId}::${hop}`, or `${actionId}::origin`. */
  readonly id: string;
  readonly actionId: string;
  /** `origin` for the authored ActionId node. Otherwise, the hop of the node. */
  readonly kind: 'origin' | ReachabilityHop;
  readonly status: HopStatus;
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly hop: ReachabilityHop;
  /** True when both the source node and the target node resolve to `ok`. */
  readonly complete: boolean;
}

/**
 * Expands the compact graph into one `origin` node per action and one node per applicable hop.
 * A `not-applicable` hop gets no node.
 */
export function reachabilityNodes(graph: ReachabilityGraph): readonly GraphNode[] {
  const nodes: GraphNode[] = [];
  for (const action of graph.actions) {
    nodes.push({ id: `${action.actionId}::origin`, actionId: action.actionId, kind: 'origin', status: 'ok' });
    for (const h of action.hops) {
      if (h.status === 'not-applicable') continue;
      nodes.push({
        id: `${action.actionId}::${h.hop}`,
        actionId: action.actionId,
        kind: h.hop,
        status: h.status,
      });
    }
  }
  return nodes;
}

/**
 * Expands the compact graph into the edge chain of each action. An edge skips a `not-applicable`
 * hop and goes to the next applicable node. An edge is `complete` when both of its nodes are `ok`.
 */
export function reachabilityEdges(graph: ReachabilityGraph): readonly GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const action of graph.actions) {
    let prevId = `${action.actionId}::origin`;
    let prevComplete = true;
    for (const h of action.hops) {
      if (h.status === 'not-applicable') continue;
      const toId = `${action.actionId}::${h.hop}`;
      edges.push({ from: prevId, to: toId, hop: h.hop, complete: prevComplete && h.status === 'ok' });
      prevId = toId;
      prevComplete = h.status === 'ok';
    }
  }
  return edges;
}
