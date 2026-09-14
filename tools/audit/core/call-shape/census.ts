// Turns located call sites and the recorded path judgements into the census:
// per intent, the Exarchos calls the source prescribes up to the next authority
// boundary, its exception paths, its discovery calls and its harness calls.
//
// It refuses rather than reporting a smaller number. A judgement whose anchor no
// longer resolves, a counted call the registry does not serve, a located call no
// judgement accounts for, and an intent whose normal path holds no Exarchos call
// are each an error, because each would otherwise read as a genuine count.

import { createHash } from 'node:crypto';
import {
  classifyRunbookSteps,
  extractSites,
  locateNeedle,
  namedReferenceFiles,
  type RegistrySnapshot,
  type RunbookLike,
  type RunbookStepView,
  type Site,
  type SitePattern,
  type SiteStatus,
} from './extract.js';

export type Multiplicity = 'once' | 'perTask' | 'perPr';

export interface Cite {
  readonly source: string;
  readonly needle: string;
}

/** A call site, named by its call and by text unique in the file that lies on the site's lines. */
export interface SiteRef {
  readonly source: string;
  readonly call: string;
  readonly at: string;
}

interface StepNotes {
  readonly why?: string;
  /** Set when the judgement records something the source gets wrong, not just a reading of it. */
  readonly flag?: string;
}

export interface SiteStep extends StepNotes {
  readonly kind: 'site';
  readonly ref: SiteRef;
  readonly per?: Multiplicity;
}

/** A call the prose prescribes by name only, with no call syntax to locate. */
export interface MentionStep extends StepNotes {
  readonly kind: 'mention';
  readonly call: string;
  readonly cite: Cite;
  readonly per?: Multiplicity;
  readonly why: string;
}

/** A fetched runbook whose steps the prose says to execute, expanded in place. */
export interface RunbookStep extends StepNotes {
  readonly kind: 'runbook';
  readonly id: string;
  readonly via: SiteRef;
  readonly omit?: readonly string[];
  readonly per?: Multiplicity;
  readonly why: string;
}

/** Another intent's normal path, run as part of this one. */
export interface IntentStep extends StepNotes {
  readonly kind: 'intent';
  readonly intent: string;
  readonly per: Multiplicity;
  readonly why: string;
}

export type Step = SiteStep | MentionStep | RunbookStep | IntentStep;

export interface ExceptionModel {
  readonly id: string;
  readonly label: string;
  readonly trigger: Cite;
  /** The normal path runs up to and including this call first; null runs all of it. */
  readonly through: string | null;
  readonly extra: readonly Step[];
  /** The branch re-invokes the skill, so the whole normal path runs again after `extra`. */
  readonly reentersNormalPath: boolean;
  readonly bound?: { readonly max: number; readonly cite: Cite };
  readonly why: string;
}

export type ExclusionKind =
  | 'restatement'
  | 'beyond-boundary'
  | 'other-phase'
  | 'alternate-mode'
  | 'stale-unregistered';

export interface Exclusion {
  readonly ref: SiteRef;
  readonly kind: ExclusionKind;
  readonly why: string;
  readonly flag?: string;
}

export interface IntentModel {
  readonly id: string;
  readonly source: string;
  readonly boundary: { readonly label: string; readonly cite: Cite };
  readonly normal: readonly Step[];
  readonly exceptions: readonly ExceptionModel[];
  /** Calls prescribed only under a condition that is on neither path, such as a fallback. */
  readonly conditional: readonly Step[];
  readonly excluded: readonly Exclusion[];
}

export interface CensusModel {
  /** Source key to repo-relative path. Every located site in these files must be accounted for. */
  readonly sources: Readonly<Record<string, string>>;
  readonly intents: readonly IntentModel[];
}

export interface CensusInputs {
  /** Repo-relative path to contents, for every model source and the runbook definitions. */
  readonly pinnedFiles: Readonly<Record<string, string>>;
  readonly runbooks: readonly RunbookLike[];
  readonly runbookSource: string;
  readonly registry: RegistrySnapshot;
  readonly registrySource: string;
  readonly contractLockSource: string;
  readonly actionIdRegistryDigest: string | null;
}

export type CallRole = 'work' | 'describe' | 'runbook-fetch' | 'native';

export interface CallEntry {
  readonly call: string;
  readonly role: CallRole;
  readonly per: Multiplicity;
  readonly source: string;
  readonly line: number | null;
  readonly via: string;
}

export interface Tally {
  readonly fixed: number;
  readonly perTask: number;
  readonly perPr: number;
  readonly formula: string;
  /** The count with every loop variable set to 1. */
  readonly atUnit: number;
}

export interface PathTally {
  readonly exarchos: Tally;
  readonly describe: Tally;
  readonly runbookFetch: Tally;
  readonly exarchosWithDiscovery: Tally;
  readonly native: Tally;
}

interface Location {
  readonly source: string;
  readonly line: number | null;
}

export interface ExceptionView {
  readonly id: string;
  readonly label: string;
  readonly trigger: Location;
  readonly through: string | null;
  readonly reentersNormalPath: boolean;
  readonly bound: (Location & { readonly max: number }) | null;
  readonly extraCalls: readonly CallEntry[];
  readonly counts: PathTally;
}

export interface DivergenceView {
  readonly runbook: string;
  readonly fetchedAt: Location;
  readonly onlyInRunbook: readonly string[];
  readonly onlyInProse: readonly string[];
}

export interface ExclusionView extends Location {
  readonly call: string;
  readonly kind: ExclusionKind;
  readonly why: string;
}

export interface IntentView {
  readonly id: string;
  readonly source: string;
  readonly boundary: Location & { readonly label: string };
  readonly normal: { readonly calls: readonly CallEntry[]; readonly counts: PathTally };
  readonly exceptions: readonly ExceptionView[];
  readonly conditional: readonly CallEntry[];
  readonly excluded: readonly ExclusionView[];
  readonly runbookDivergence: readonly DivergenceView[];
}

export interface SiteView {
  readonly line: number;
  readonly endLine: number;
  readonly call: string;
  readonly pattern: SitePattern;
  readonly status: SiteStatus;
  readonly runbookId: string | null;
  readonly dispositions: readonly string[];
}

export interface Judgement {
  readonly intent: string;
  readonly path: string;
  readonly kind: string;
  readonly subject: string;
  readonly decision: string;
  readonly source: string;
  readonly line: number | null;
  readonly flag: string | null;
}

export interface SummaryRow {
  readonly intent: string;
  readonly endsAt: string;
  readonly normalExarchos: string;
  readonly normalExarchosAtUnit: number;
  readonly exceptions: readonly { readonly id: string; readonly exarchos: string; readonly atUnit: number }[];
  readonly describe: string;
  readonly runbookFetch: string;
  readonly conditionalDiscovery: number;
  readonly native: string;
}

export interface CallShapeCensus {
  readonly census: 'static-call-shape';
  readonly evidenceClass: 'hypothesis-baseline';
  readonly caveat: string;
  readonly method: readonly string[];
  readonly loops: Readonly<Record<string, string>>;
  readonly summary: readonly SummaryRow[];
  readonly pins: {
    readonly inputs: readonly { readonly file: string; readonly sha256: string }[];
    readonly registry: {
      readonly file: string;
      readonly tools: number;
      readonly visibleTools: number;
      readonly actions: number;
      readonly actionIdsSha256: string;
    };
    readonly contractAuthority: { readonly file: string; readonly actionIdRegistryDigest: string | null };
  };
  readonly intents: readonly IntentView[];
  readonly runbooks: readonly {
    readonly id: string;
    readonly phase: string;
    readonly steps: readonly RunbookStepView[];
    readonly counts: { readonly exarchos: number; readonly native: number; readonly decision: number };
  }[];
  readonly sites: Readonly<Record<string, readonly SiteView[]>>;
  readonly judgements: readonly Judgement[];
  readonly findings: {
    readonly unregisteredSites: readonly (Location & {
      readonly call: string;
      readonly status: SiteStatus;
      readonly dispositions: readonly string[];
    })[];
    readonly unregisteredRunbookSteps: readonly { readonly runbook: string; readonly step: number; readonly call: string }[];
    readonly runbookDivergence: readonly (DivergenceView & { readonly intent: string })[];
    readonly flagged: readonly (Location & { readonly intent: string; readonly subject: string; readonly flag: string })[];
  };
  readonly scope: {
    readonly counted: string;
    readonly lowerBound: string;
    readonly unreadReferences: readonly { readonly skill: string; readonly named: readonly string[] }[];
  };
}

const CAVEAT =
  'Source-derived: this counts the calls the canonical skills and runbooks PRESCRIBE, not the calls agents were observed to make. ' +
  'It is a hypothesis baseline, not production evidence. The observed half, replayed from real transcripts, is not part of this file.';

const METHOD: readonly string[] = [
  'Call sites are located by spelling, never hand-listed: call expressions, backtick spans naming a tool and a verb, a tool beside an action key, bare action keys resolved to the one tool that serves the name, harness-call placeholders, and fenced shell blocks.',
  'Tool names and the action roster come from the registry snapshot. A counted call the roster does not serve is refused, not counted.',
  'Which path a located site belongs to is a recorded judgement anchored to text in its source. Every located site must be placed on a path or excluded with a reason, so a new call cannot be silently ignored and a removed one cannot silently count as zero.',
  'Where the prose names a loop, a call is counted per task or per pull request and reported as a formula. Where it names none, the call is counted once.',
  'Exception paths count only the calls their branch names. A branch that re-invokes the skill adds the normal path again. Re-runs the prose does not name are not counted, so exception counts are lower bounds.',
  'A fetched runbook is expanded in place only when the skill says to execute its steps. Otherwise its steps are compared with the prose path and every difference is reported.',
  'describe and runbook calls are Exarchos MCP calls, counted apart from work calls. Harness calls are counted apart and are in no Exarchos total.',
];

const LOOPS: Readonly<Record<string, string>> = {
  tasks: 'tasks dispatched in one delegation',
  prs: 'pull requests in one synthesized stack',
  atUnit: 'every loop variable set to 1',
};

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function roleOf(call: string): CallRole {
  if (call.startsWith('native:')) return 'native';
  if (call.endsWith('.describe')) return 'describe';
  if (call === 'exarchos_orchestrate.runbook') return 'runbook-fetch';
  return 'work';
}

function formulaOf(fixed: number, perTask: number, perPr: number): string {
  const terms: string[] = [];
  if (fixed > 0) terms.push(String(fixed));
  if (perTask > 0) terms.push(`${perTask}*tasks`);
  if (perPr > 0) terms.push(`${perPr}*prs`);
  return terms.length === 0 ? '0' : terms.join(' + ');
}

function tally(calls: readonly CallEntry[], roles: ReadonlySet<CallRole>): Tally {
  let fixed = 0;
  let perTask = 0;
  let perPr = 0;
  for (const call of calls) {
    if (!roles.has(call.role)) continue;
    if (call.per === 'once') fixed += 1;
    else if (call.per === 'perTask') perTask += 1;
    else perPr += 1;
  }
  return { fixed, perTask, perPr, formula: formulaOf(fixed, perTask, perPr), atUnit: fixed + perTask + perPr };
}

function tallyPath(calls: readonly CallEntry[]): PathTally {
  return {
    exarchos: tally(calls, new Set(['work'])),
    describe: tally(calls, new Set(['describe'])),
    runbookFetch: tally(calls, new Set(['runbook-fetch'])),
    exarchosWithDiscovery: tally(calls, new Set(['work', 'describe', 'runbook-fetch'])),
    native: tally(calls, new Set(['native'])),
  };
}

interface Fetch {
  readonly runbook: string;
  readonly at: Location;
}

export function buildCallShapeCensus(
  inputs: CensusInputs,
  model: CensusModel,
): { readonly census: CallShapeCensus; readonly errors: readonly string[] } {
  const errors: string[] = [];
  const fail = (message: string): void => {
    if (!errors.includes(message)) errors.push(message);
  };
  const { registry } = inputs;

  const actionIds = registry.tools.flatMap((tool) => tool.actions.map((action) => `${tool.name}.${action}`)).sort();
  if (actionIds.length !== registry.counts.actions) {
    fail(`REGISTRY_COUNT_MISMATCH: the snapshot counts ${registry.counts.actions} actions but lists ${actionIds.length}`);
  }
  const registered = new Set(actionIds);
  const rosterDigest = sha256(actionIds.join('\n'));
  // The contract lock digests the same flattened, sorted roster. When the two
  // disagree the snapshot is not the contract, and validating against it would
  // certify calls against the wrong authority.
  if (inputs.actionIdRegistryDigest !== null && inputs.actionIdRegistryDigest !== `sha256:${rosterDigest}`) {
    fail(
      `REGISTRY_DIVERGES_FROM_CONTRACT_LOCK: ${inputs.registrySource} rosters sha256:${rosterDigest} but ${inputs.contractLockSource} pins ${inputs.actionIdRegistryDigest}`,
    );
  }

  const texts = new Map<string, string>();
  const sitesBySource = new Map<string, readonly Site[]>();
  const dispositions = new Map<string, Set<string>>();
  const fileOf = (key: string): string => model.sources[key] ?? key;

  for (const [key, file] of Object.entries(model.sources)) {
    const text = inputs.pinnedFiles[file];
    if (text === undefined) {
      fail(`MISSING_SOURCE ${key}: ${file} is not among the pinned inputs`);
      continue;
    }
    texts.set(key, text);
    const sites = extractSites(text, registry);
    if (sites.length === 0) fail(`EMPTY_SOURCE ${file}: the extractor located no call sites`);
    sitesBySource.set(key, sites);
  }

  const runbookViews = new Map<string, readonly RunbookStepView[]>();
  for (const runbook of inputs.runbooks) {
    if (runbookViews.has(runbook.id)) fail(`DUPLICATE_RUNBOOK ${runbook.id}`);
    runbookViews.set(runbook.id, classifyRunbookSteps(runbook, registry));
  }

  const locate = (cite: Cite, context: string, code: string): Location => {
    const text = texts.get(cite.source);
    if (text === undefined) {
      fail(`UNKNOWN_SOURCE ${context}: ${cite.source}`);
      return { source: fileOf(cite.source), line: null };
    }
    const hit = locateNeedle(text, cite.needle);
    if ('error' in hit) {
      fail(`${code} ${context} in ${fileOf(cite.source)}: ${hit.error}`);
      return { source: fileOf(cite.source), line: null };
    }
    return { source: fileOf(cite.source), line: hit.line };
  };

  const resolveSite = (ref: SiteRef, label: string): Site | null => {
    const where = locate({ source: ref.source, needle: ref.at }, `${label} ${ref.call}`, 'UNRESOLVED_SITE_REF');
    const sites = sitesBySource.get(ref.source);
    const line = where.line;
    if (sites === undefined || line === null) return null;
    const matches = sites.flatMap((site, index) =>
      site.call === ref.call && site.line <= line && line <= site.endLine ? [index] : [],
    );
    const [index] = matches;
    const site = index === undefined ? undefined : sites[index];
    if (matches.length !== 1 || index === undefined || site === undefined) {
      fail(
        `UNRESOLVED_SITE_REF ${label}: ${fileOf(ref.source)}:${line} holds ${matches.length} ${ref.call} call sites, expected exactly one`,
      );
      return null;
    }
    const key = `${ref.source}#${index}`;
    const labels = dispositions.get(key) ?? new Set<string>();
    labels.add(label);
    dispositions.set(key, labels);
    return site;
  };

  const compose = (outer: Multiplicity, inner: Multiplicity, context: string): Multiplicity => {
    if (outer === 'once') return inner;
    if (inner !== 'once') fail(`NESTED_LOOP ${context}: ${inner} inside ${outer} is not modelled`);
    return outer;
  };

  const expand = (
    step: Step,
    outer: Multiplicity,
    label: string,
    stack: readonly string[],
    fetches: Fetch[],
  ): CallEntry[] => {
    const per = compose(outer, step.per ?? 'once', label);
    switch (step.kind) {
      case 'site': {
        const site = resolveSite(step.ref, label);
        if (site === null) return [];
        const source = fileOf(step.ref.source);
        if (site.status !== 'registered' && site.status !== 'harness') {
          fail(`UNREGISTERED_STEP ${label}: ${source}:${site.line} ${site.call} is ${site.status} and cannot be counted`);
        }
        const role = roleOf(site.call);
        if (role === 'runbook-fetch' && site.runbookId !== null) {
          fetches.push({ runbook: site.runbookId, at: { source, line: site.line } });
        }
        return [{ call: site.call, role, per, source, line: site.line, via: 'site' }];
      }
      case 'mention': {
        const at = locate(step.cite, `${label} ${step.call}`, 'UNRESOLVED_CITE');
        if (!step.call.startsWith('native:') && !registered.has(step.call)) {
          fail(`UNREGISTERED_STEP ${label}: the mentioned call ${step.call} is not a registered action`);
        }
        return [{ call: step.call, role: roleOf(step.call), per, source: at.source, line: at.line, via: 'mention' }];
      }
      case 'runbook': {
        const out: CallEntry[] = [];
        const site = resolveSite(step.via, label);
        if (site !== null) {
          if (site.call !== 'exarchos_orchestrate.runbook' || site.runbookId !== step.id) {
            fail(
              `RUNBOOK_VIA_MISMATCH ${label}: ${fileOf(step.via.source)}:${site.line} fetches ${site.runbookId ?? 'no runbook'}, not ${step.id}`,
            );
          }
          out.push({
            call: site.call,
            role: 'runbook-fetch',
            per,
            source: fileOf(step.via.source),
            line: site.line,
            via: 'site',
          });
        }
        const views = runbookViews.get(step.id);
        if (views === undefined) {
          fail(`UNKNOWN_RUNBOOK ${label}: ${step.id}`);
          return out;
        }
        const omit = new Set(step.omit ?? []);
        for (const name of omit) {
          if (!views.some((view) => view.call === name)) fail(`OMIT_NOT_IN_RUNBOOK ${label}: ${step.id} has no ${name} step`);
        }
        views.forEach((view, index) => {
          if (view.surface === 'decision' || omit.has(view.call)) return;
          if (view.status === 'unregistered') {
            fail(`UNREGISTERED_STEP ${label}: runbook ${step.id} step ${index + 1} ${view.call} is not a registered action`);
          }
          out.push({
            call: view.call,
            role: view.surface === 'native' ? 'native' : roleOf(view.call),
            per,
            source: inputs.runbookSource,
            line: null,
            via: `runbook:${step.id}#${index + 1}`,
          });
        });
        return out;
      }
      case 'intent': {
        if (stack.includes(step.intent)) {
          fail(`INTENT_CYCLE ${label}: ${[...stack, step.intent].join(' > ')}`);
          return [];
        }
        const inner = model.intents.find((candidate) => candidate.id === step.intent);
        if (inner === undefined) {
          fail(`UNKNOWN_INTENT ${label}: ${step.intent}`);
          return [];
        }
        return inner.normal
          .flatMap((innerStep) => expand(innerStep, per, label, [...stack, step.intent], []))
          .map((entry) => ({ ...entry, via: `intent:${step.intent}/${entry.via}` }));
      }
    }
  };

  const judgements: Judgement[] = [];
  const judgeStep = (intent: string, pathName: string, step: Step): void => {
    const per = step.per ?? 'once';
    if (step.why === undefined && step.flag === undefined && per === 'once') return;
    let subject: string;
    let at: Location;
    switch (step.kind) {
      case 'site':
        subject = step.ref.call;
        at = locate({ source: step.ref.source, needle: step.ref.at }, `${intent}:${pathName}`, 'UNRESOLVED_SITE_REF');
        break;
      case 'mention':
        subject = step.call;
        at = locate(step.cite, `${intent}:${pathName}`, 'UNRESOLVED_CITE');
        break;
      case 'runbook':
        subject = `runbook:${step.id}`;
        at = locate({ source: step.via.source, needle: step.via.at }, `${intent}:${pathName}`, 'UNRESOLVED_SITE_REF');
        break;
      case 'intent':
        subject = `intent:${step.intent}`;
        at = { source: `intent:${step.intent}`, line: null };
        break;
    }
    const decision = [step.why, per === 'once' ? undefined : `counted ${per}`]
      .filter((part): part is string => part !== undefined)
      .join('; ');
    judgements.push({
      intent,
      path: pathName,
      kind: step.kind,
      subject,
      decision,
      source: at.source,
      line: at.line,
      flag: step.flag ?? null,
    });
  };

  const intents: IntentView[] = model.intents.map((intent) => {
    if (model.sources[intent.source] === undefined) fail(`UNKNOWN_SOURCE ${intent.id}: ${intent.source}`);
    const fetches: Fetch[] = [];
    const normalCalls = intent.normal.flatMap((step) => expand(step, 'once', `${intent.id}:normal`, [intent.id], fetches));
    const normalCounts = tallyPath(normalCalls);
    if (normalCounts.exarchos.atUnit === 0) {
      fail(
        `EMPTY_NORMAL_PATH ${intent.id}: no Exarchos work call resolved on the normal path, and a census that counts nothing cannot tell zero calls from a broken extractor`,
      );
    }
    // Runbook steps and prose mentions resolve without the extractor, so they
    // can keep a count above zero while the extractor reads nothing in this
    // intent's source. At least one call on the path must be one it located.
    if (!normalCalls.some((call) => call.via === 'site' || call.via.endsWith('/site'))) {
      fail(
        `NORMAL_PATH_UNLOCATED ${intent.id}: no call on the normal path was located in its source, so the count does not depend on the extractor reading it`,
      );
    }

    const boundaryAt = locate(intent.boundary.cite, `${intent.id}:boundary`, 'UNRESOLVED_CITE');
    judgements.push({
      intent: intent.id,
      path: 'boundary',
      kind: 'boundary',
      subject: 'boundary',
      decision: intent.boundary.label,
      source: boundaryAt.source,
      line: boundaryAt.line,
      flag: null,
    });
    for (const step of intent.normal) judgeStep(intent.id, 'normal', step);

    const exceptions: ExceptionView[] = intent.exceptions.map((exception) => {
      const label = `${intent.id}:exception:${exception.id}`;
      let base = normalCalls;
      if (exception.through !== null) {
        const through = exception.through;
        const cut = normalCalls.findIndex((call) => call.call === through);
        if (cut === -1) fail(`EXCEPTION_THROUGH_NOT_ON_PATH ${label}: ${through}`);
        else base = normalCalls.slice(0, cut + 1);
      }
      const extraCalls = exception.extra.flatMap((step) => expand(step, 'once', label, [intent.id], []));
      if (exception.through === null && extraCalls.length === 0 && !exception.reentersNormalPath) {
        fail(`VACUOUS_EXCEPTION ${label}: it runs the whole normal path and adds nothing, so it is not a different path`);
      }
      const trigger = locate(exception.trigger, `${label} trigger`, 'UNRESOLVED_CITE');
      const bound =
        exception.bound === undefined
          ? null
          : { max: exception.bound.max, ...locate(exception.bound.cite, `${label} bound`, 'UNRESOLVED_CITE') };
      judgements.push({
        intent: intent.id,
        path: `exception:${exception.id}`,
        kind: 'exception',
        subject: exception.label,
        decision: exception.why,
        source: trigger.source,
        line: trigger.line,
        flag: null,
      });
      for (const step of exception.extra) judgeStep(intent.id, `exception:${exception.id}`, step);
      return {
        id: exception.id,
        label: exception.label,
        trigger,
        through: exception.through,
        reentersNormalPath: exception.reentersNormalPath,
        bound,
        extraCalls,
        counts: tallyPath([...base, ...extraCalls, ...(exception.reentersNormalPath ? normalCalls : [])]),
      };
    });

    const conditional = intent.conditional.flatMap((step) =>
      expand(step, 'once', `${intent.id}:conditional`, [intent.id], []),
    );
    for (const step of intent.conditional) judgeStep(intent.id, 'conditional', step);

    const excluded: ExclusionView[] = intent.excluded.flatMap((exclusion) => {
      const site = resolveSite(exclusion.ref, `${intent.id}:excluded:${exclusion.kind}`);
      if (site === null) return [];
      const source = fileOf(exclusion.ref.source);
      if (exclusion.kind === 'stale-unregistered' && site.status === 'registered') {
        fail(`STALE_EXCLUSION_IS_REGISTERED ${intent.id}: ${source}:${site.line} ${site.call} is registered`);
      }
      judgements.push({
        intent: intent.id,
        path: 'excluded',
        kind: exclusion.kind,
        subject: site.call,
        decision: exclusion.why,
        source,
        line: site.line,
        flag: exclusion.flag ?? null,
      });
      return [{ call: site.call, kind: exclusion.kind, why: exclusion.why, source, line: site.line }];
    });

    const runbookDivergence: DivergenceView[] = fetches.flatMap((fetch) => {
      const views = runbookViews.get(fetch.runbook);
      if (views === undefined) {
        fail(`UNKNOWN_RUNBOOK ${intent.id}: the prose fetches ${fetch.runbook}`);
        return [];
      }
      if (!views.some((view) => view.surface === 'exarchos')) return [];
      const runbookCalls = new Set(views.filter((view) => view.surface !== 'decision').map((view) => view.call));
      const proseCalls = new Set(
        normalCalls.filter((call) => call.role === 'work' || call.role === 'native').map((call) => call.call),
      );
      return [
        {
          runbook: fetch.runbook,
          fetchedAt: fetch.at,
          onlyInRunbook: [...runbookCalls].filter((call) => !proseCalls.has(call)).sort(),
          onlyInProse: [...proseCalls].filter((call) => !runbookCalls.has(call)).sort(),
        },
      ];
    });

    return {
      id: intent.id,
      source: fileOf(intent.source),
      boundary: { label: intent.boundary.label, ...boundaryAt },
      normal: { calls: normalCalls, counts: normalCounts },
      exceptions,
      conditional,
      excluded,
      runbookDivergence,
    };
  });

  const sites: Record<string, SiteView[]> = {};
  for (const [key, list] of sitesBySource) {
    sites[fileOf(key)] = list.map((site, index) => {
      const labels = [...(dispositions.get(`${key}#${index}`) ?? [])].sort();
      if (labels.length === 0) {
        fail(
          `UNDISPOSITIONED_SITE ${fileOf(key)}:${site.line} ${site.call} is on no path and excluded by no judgement`,
        );
      }
      return { ...site, dispositions: labels };
    });
  }

  const runbooks = inputs.runbooks.map((runbook) => {
    const steps = runbookViews.get(runbook.id) ?? [];
    return {
      id: runbook.id,
      phase: runbook.phase,
      steps,
      counts: {
        exarchos: steps.filter((step) => step.surface === 'exarchos').length,
        native: steps.filter((step) => step.surface === 'native').length,
        decision: steps.filter((step) => step.surface === 'decision').length,
      },
    };
  });

  const summary: SummaryRow[] = intents.map((intent) => ({
    intent: intent.id,
    endsAt: intent.boundary.label,
    normalExarchos: intent.normal.counts.exarchos.formula,
    normalExarchosAtUnit: intent.normal.counts.exarchos.atUnit,
    exceptions: intent.exceptions.map((exception) => ({
      id: exception.id,
      exarchos: exception.counts.exarchos.formula,
      atUnit: exception.counts.exarchos.atUnit,
    })),
    describe: intent.normal.counts.describe.formula,
    runbookFetch: intent.normal.counts.runbookFetch.formula,
    conditionalDiscovery: intent.conditional.filter((call) => call.role === 'describe' || call.role === 'runbook-fetch')
      .length,
    native: intent.normal.counts.native.formula,
  }));

  const census: CallShapeCensus = {
    census: 'static-call-shape',
    evidenceClass: 'hypothesis-baseline',
    caveat: CAVEAT,
    method: METHOD,
    loops: LOOPS,
    summary,
    pins: {
      inputs: Object.entries(inputs.pinnedFiles)
        .map(([file, text]) => ({ file, sha256: sha256(text) }))
        .sort((a, b) => a.file.localeCompare(b.file)),
      registry: {
        file: inputs.registrySource,
        tools: registry.counts.tools,
        visibleTools: registry.counts.visibleTools,
        actions: registry.counts.actions,
        actionIdsSha256: rosterDigest,
      },
      contractAuthority: {
        file: inputs.contractLockSource,
        actionIdRegistryDigest: inputs.actionIdRegistryDigest,
      },
    },
    intents,
    runbooks,
    sites,
    judgements,
    findings: {
      unregisteredSites: Object.entries(sites).flatMap(([source, list]) =>
        list
          .filter((site) => site.status !== 'registered' && site.status !== 'harness')
          .map((site) => ({
            source,
            line: site.line,
            call: site.call,
            status: site.status,
            dispositions: site.dispositions,
          })),
      ),
      unregisteredRunbookSteps: runbooks.flatMap((runbook) =>
        runbook.steps.flatMap((step, index) =>
          step.status === 'unregistered' ? [{ runbook: runbook.id, step: index + 1, call: step.call }] : [],
        ),
      ),
      runbookDivergence: intents.flatMap((intent) =>
        intent.runbookDivergence.map((divergence) => ({ intent: intent.id, ...divergence })),
      ),
      flagged: judgements.flatMap((judgement) =>
        judgement.flag === null
          ? []
          : [
              {
                intent: judgement.intent,
                subject: judgement.subject,
                flag: judgement.flag,
                source: judgement.source,
                line: judgement.line,
              },
            ],
      ),
    },
    scope: {
      counted:
        'Exarchos MCP calls and harness calls spelled out in each SKILL.md body, plus the steps of the runbooks those bodies say to execute.',
      lowerBound:
        'The references/ files a SKILL.md names are not read. A call whose only recipe lives there is not counted, so every path here is a lower bound on what the full skill tree prescribes.',
      unreadReferences: Object.entries(model.sources).map(([key, file]) => ({
        skill: file,
        named: namedReferenceFiles(texts.get(key) ?? ''),
      })),
    },
  };

  return { census, errors };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => canonicalize(item));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      out[key] = canonicalize(inner);
    }
    return out;
  }
  return value;
}

/** Sorted keys, two-space indent, trailing newline: the same bytes for the same census. */
export function serializeCallShapeCensus(census: CallShapeCensus): string {
  return `${JSON.stringify(canonicalize(census), null, 2)}\n`;
}

function where(location: Location): string {
  return location.line === null ? location.source : `${location.source}:${location.line}`;
}

export function renderCallShapeSummary(census: CallShapeCensus): string {
  const out: string[] = [
    '<!-- Generated by tools/audit/core/call-shape/measure.ts from the census beside it. Do not edit; regenerate. -->',
    '',
    '# Prescribed call shape (static census)',
    '',
    `> ${census.caveat}`,
    '',
    'Counts read `fixed + k*tasks + m*prs`. The N=1 columns set every loop variable to 1. Describe and runbook fetches are Exarchos MCP calls, counted apart from the work calls. Harness calls are not Exarchos calls and are in no Exarchos total. Conditional discovery counts describe or runbook calls prescribed only as a fallback or reference.',
    '',
    '| Intent | Ends at | Exarchos, normal | N=1 | Exception paths, Exarchos (N=1) | Describe | Runbook fetch | Conditional discovery | Harness |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const row of census.summary) {
    const exceptions =
      row.exceptions.length === 0
        ? 'none'
        : row.exceptions.map((exception) => `${exception.id}: ${exception.exarchos} (${exception.atUnit})`).join('<br>');
    out.push(
      `| ${row.intent} | ${row.endsAt} | ${row.normalExarchos} | ${row.normalExarchosAtUnit} | ${exceptions} | ${row.describe} | ${row.runbookFetch} | ${row.conditionalDiscovery} | ${row.native} |`,
    );
  }

  for (const intent of census.intents) {
    out.push('', `## ${intent.id}`, '', `Ends at: ${intent.boundary.label} (\`${where(intent.boundary)}\`)`, '');
    intent.normal.calls.forEach((call, index) => {
      const per = call.per === 'once' ? '' : `, ${call.per}`;
      const via = call.via === 'site' ? '' : `, via ${call.via}`;
      out.push(`${index + 1}. \`${call.call}\` (${call.role}${per}${via}) \`${where(call)}\``);
    });
    for (const exception of intent.exceptions) {
      const runs =
        exception.through === null ? 'the whole normal path' : `the normal path through \`${exception.through}\``;
      const again = exception.reentersNormalPath ? ', then the whole normal path again' : '';
      const bound = exception.bound === null ? '' : `, at most ${exception.bound.max} times (\`${where(exception.bound)}\`)`;
      const extra =
        exception.extraCalls.length === 0
          ? 'no named call'
          : exception.extraCalls.map((call) => `\`${call.call}\``).join(', ');
      const counts = exception.counts;
      out.push(
        '',
        `Exception \`${exception.id}\`: ${exception.label} (\`${where(exception.trigger)}\`)`,
        '',
        `- Runs ${runs}, adds ${extra}${again}${bound}.`,
        `- Exarchos ${counts.exarchos.formula}; describe ${counts.describe.formula}; runbook fetch ${counts.runbookFetch.formula}; harness ${counts.native.formula}.`,
      );
    }
  }

  out.push('', '## Findings', '');
  const { findings } = census;
  if (findings.unregisteredSites.length === 0) out.push('- No located call names an unregistered action.');
  for (const site of findings.unregisteredSites) {
    out.push(`- Unregistered: \`${site.call}\` (${site.status}) at \`${where(site)}\`, ${site.dispositions.join(', ')}.`);
  }
  for (const step of findings.unregisteredRunbookSteps) {
    out.push(`- Unregistered runbook step: \`${step.call}\` in ${step.runbook} step ${step.step}.`);
  }
  for (const divergence of findings.runbookDivergence) {
    out.push(
      `- ${divergence.intent} fetches runbook ${divergence.runbook} at \`${where(divergence.fetchedAt)}\` but spells a different path. Only in the runbook: ${divergence.onlyInRunbook.map((call) => `\`${call}\``).join(', ') || 'nothing'}. Only in the prose: ${divergence.onlyInProse.map((call) => `\`${call}\``).join(', ') || 'nothing'}.`,
    );
  }
  for (const flagged of findings.flagged) {
    out.push(`- ${flagged.intent}, \`${flagged.subject}\` at \`${where(flagged)}\`: ${flagged.flag}`);
  }

  out.push('', '## Scope', '', `- ${census.scope.counted}`, `- ${census.scope.lowerBound}`);
  for (const skill of census.scope.unreadReferences) {
    out.push(`- Not read, named by \`${skill.skill}\`: ${skill.named.map((file) => `\`${file}\``).join(', ') || 'none'}.`);
  }

  const { pins } = census;
  out.push(
    '',
    '## Pins',
    '',
    `- Registry: ${pins.registry.actions} actions over ${pins.registry.tools} tools (${pins.registry.visibleTools} visible), action ids sha256 \`${pins.registry.actionIdsSha256}\` from \`${pins.registry.file}\`.`,
    `- Contract authority \`action-id-registry\` digest \`${pins.contractAuthority.actionIdRegistryDigest ?? 'absent'}\` from \`${pins.contractAuthority.file}\`.`,
  );
  for (const input of pins.inputs) out.push(`- \`${input.file}\` sha256 \`${input.sha256}\``);
  return `${out.join('\n')}\n`;
}
