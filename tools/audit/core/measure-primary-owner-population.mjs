// What does "exactly one primary owner" quantify over? Enumerate each candidate.
//
// ── Why this is a census and not a gate ─────────────────────────────────────
//
// The one-primary-owner criterion has been specified three times and refuted
// three times, always for the same reason: the check was designed before anyone
// decided which population it ranged over. Two populations are obvious and both
// are wrong. Over the events an `EffectPlan` names, the slice arming the check
// would author its own input, so drift is unreachable and the gate cannot fail.
// Over the live emission edges the check is red on arrival — and the largest
// red row is `gate.executed`, where many gates each emit it, each the primary
// emitter of its own occurrence. That is not a catalog defect; it is evidence
// the criterion keys on event TYPE while the catalog keys on something else.
//
// So this file counts rather than judges. It enumerates the population under
// every candidate key, keeps zero-primary and multi-primary apart (they are
// different defects and must not share a disposition), and writes the numbers
// down. The decision is made against the output, not against a description of
// it.
//
// ── The two counts the criterion conflates ─────────────────────────────────
//
// "Exactly one primary owner" can be read two ways over the same catalog, and
// they disagree. Counting primary EDGES asks how many declarations claim the
// primary role. Counting distinct primary OWNERS asks how many accountable
// parties those declarations name. Twenty-four gate actions all declaring
// `owner: 'orchestrate'` are twenty-four edges and one owner. The criterion
// says "owner", so both are measured and reported separately; picking one
// silently is how the previous attempts smuggled the modelling decision into
// an implementation detail.
//
// ── Determinism is the point ────────────────────────────────────────────────
//
// The output carries no timestamp and no commit sha, so re-running on an
// unchanged tree reproduces it byte for byte and `--check` can tell "the
// catalog moved" from "the script ran again". A census whose output churns on
// every run cannot be evidence of anything.
//
// Usage:
//   node tools/audit/core/measure-primary-owner-population.mjs           # write
//   node tools/audit/core/measure-primary-owner-population.mjs --check   # verify

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = path.join(ROOT, 'tools/audit/core/primary-owner-population.json');

// ─── Raw facts, read from the live registry as VALUES ────────────────────────
//
// Read by importing, never by parsing: a regex over `src/registry/actions/**`
// would be a second authority on what the registry contains, and the whole
// point of the measurement is that it agrees with what boots. The registry
// pulls the SQLite substrate, so it runs through the workspace's own `tsx`
// rather than this process.
const EXTRACT = `
import { TOOL_REGISTRY } from './src/registry.js';
import { EVENT_ANNOTATIONS } from './src/events/event-annotations.js';
import { MODULE_EMISSIONS } from './src/events/module-emissions.js';
import { VCS_LEDGER_EMISSIONS } from './src/vcs/mutation-owner.js';
import { PROMOTION_EXECUTED } from './src/install/atomic-promotion.js';

const edges = [];
for (const tool of TOOL_REGISTRY) {
  for (const action of tool.actions) {
    for (const emission of action.autoEmits ?? []) {
      edges.push({
        event: emission.event,
        action: action.name,
        declaringTool: tool.name,
        condition: emission.condition,
        role: emission.role ?? null,
        owner: emission.owner ?? null,
      });
    }
  }
}

const annotations = {};
for (const [event, registration] of Object.entries(EVENT_ANNOTATIONS)) {
  annotations[event] = { tier: registration.tier, lifecycle: registration.lifecycle };
}

// The events an EffectPlan names. Derived from the two live plan sites rather
// than transcribed, so a third sink appearing shows up here instead of going
// unnoticed.
const planDeclared = [
  ...VCS_LEDGER_EMISSIONS.emissions.map((e) => e.event),
  PROMOTION_EXECUTED,
];

process.stdout.write(
  '<<<CENSUS>>>' +
    JSON.stringify({
      edges,
      annotations,
      moduleEmissions: MODULE_EMISSIONS.map((m) => ({
        event: m.event,
        module: m.module,
        trigger: m.trigger,
      })),
      planDeclared,
    }),
);
`;

function readRawFacts() {
  const tmp = path.join(ROOT, '.tmp-primary-owner-census.mts');
  fs.writeFileSync(tmp, EXTRACT, 'utf8');
  try {
    const out = execFileSync('npx', ['tsx', tmp], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const marker = out.indexOf('<<<CENSUS>>>');
    if (marker === -1) throw new Error(`census extractor produced no payload:\n${out}`);
    return JSON.parse(out.slice(marker + '<<<CENSUS>>>'.length));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// ─── Candidate keys ─────────────────────────────────────────────────────────

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Group the edges by a key, then count primaries within each group two ways.
 *
 * `countOwners` is what separates the two readings of the criterion: counting
 * distinct owner strings asks how many parties are accountable, counting edges
 * asks how many declarations exist. A group whose edges all name one owner has
 * one owner and many edges.
 */
function tally(edges, keyOf) {
  const groups = new Map();
  for (const edge of edges) {
    const key = keyOf(edge);
    let group = groups.get(key);
    if (group === undefined) {
      group = { key, edges: [], primaryEdges: [], primaryOwners: new Set() };
      groups.set(key, group);
    }
    group.edges.push(edge);
    if (edge.role === 'primary') {
      group.primaryEdges.push(edge);
      if (edge.owner !== null) group.primaryOwners.add(edge.owner);
    }
  }
  return [...groups.values()].sort((a, b) => byName(a.key, b.key));
}

/**
 * Split a tallied population into satisfying, zero-primary and multi-primary.
 *
 * The two violation arms stay separate all the way to the output. Zero primary
 * owners means nothing claims the event; more than one means two things claim
 * it. Merging them into a single "violations" count is how a disposition ends
 * up applying the wrong repair to half its subjects.
 */
function verdict(groups, count) {
  const satisfied = [];
  const zeroPrimary = [];
  const multiPrimary = [];
  for (const group of groups) {
    const n = count(group);
    const row = {
      key: group.key,
      primaryEdges: group.primaryEdges.length,
      primaryOwners: [...group.primaryOwners].sort(byName),
      declaringEdges: group.edges.length,
      declaredBy: group.edges
        .map((e) => `${e.declaringTool}.${e.action}`)
        .sort(byName)
        .filter((id, i, all) => all.indexOf(id) === i),
    };
    if (n === 1) satisfied.push(row);
    else if (n === 0) zeroPrimary.push(row);
    else multiPrimary.push(row);
  }
  return {
    populationSize: groups.length,
    satisfyingCount: satisfied.length,
    zeroPrimaryCount: zeroPrimary.length,
    multiPrimaryCount: multiPrimary.length,
    zeroPrimary,
    multiPrimary,
    // The satisfying rows are the population a gate would range over without
    // failing. Their key names alone are enough; the detail is on the
    // violations, which are the rows a disposition has to act on.
    satisfyingKeys: satisfied.map((row) => row.key),
  };
}

/**
 * Can this key's two failure arms ever fire?
 *
 * A key with no live violations is not the same as a key that can never have
 * one, and the difference is the whole reason this census exists — the
 * per-emission-site key looks clean for the same reason a deleted guard looks
 * clean. So each key is probed with the SAME two drifts, over a COPY of the
 * measured edges, and reported on whether it notices.
 *
 * The two recipes are the realistic drifts, not arbitrary mutations:
 *
 *   • MULTI — a second action, in a different tool, starts declaring itself the
 *     primary emitter of an already-owned event. That is two parties claiming
 *     one event, which is exactly what a bijection exists to catch.
 *   • ZERO — an event's only primary edge is relabelled `recovery`. That is not
 *     hypothetical: it is what `merge.recovered` looks like today.
 *
 * This is a reachability probe over data, NOT the seeded kill-probe a shipped
 * gate owes. It says an arm is expressible; it does not say a check was
 * observed to reject it.
 */
function probeArms(edges, keyOf, count) {
  const subject = edges.find((e) => e.role === 'primary');
  if (subject === undefined) return { multiArmReachable: false, zeroArmReachable: false };

  const groupCount = (population, key) => {
    const group = tally(population, keyOf).find((g) => g.key === key);
    return group === undefined ? null : count(group);
  };

  // MULTI: clone the subject onto a foreign tool, still claiming primary.
  const foreign = {
    ...subject,
    action: `${subject.action}__seeded`,
    declaringTool: '__seeded_tool',
    owner: '__seeded_owner',
  };
  const withForeign = [...edges, foreign];
  const multiArmReachable = tally(withForeign, keyOf).some((g) => count(g) > 1);

  // ZERO: relabel every primary edge of one event as recovery. Pick an event
  // with a single primary so the relabel is total for that event.
  const primariesPerEvent = new Map();
  for (const edge of edges) {
    if (edge.role !== 'primary') continue;
    primariesPerEvent.set(edge.event, (primariesPerEvent.get(edge.event) ?? 0) + 1);
  }
  const soleOwned = [...primariesPerEvent.entries()].find(([, n]) => n === 1);
  let zeroArmReachable = false;
  if (soleOwned !== undefined) {
    const [event] = soleOwned;
    const relabelled = edges.map((e) =>
      e.event === event && e.role === 'primary' ? { ...e, role: 'recovery' } : e,
    );
    zeroArmReachable = tally(relabelled, keyOf).some(
      (g) => g.edges.some((e) => e.event === event) && count(g) === 0,
    );
  }

  return { multiArmReachable, zeroArmReachable, probedWith: { multi: foreign.event, zero: soleOwned?.[0] ?? null } };
}

function measure(raw) {
  const edges = [...raw.edges].sort(
    (a, b) =>
      byName(a.event, b.event) || byName(a.declaringTool, b.declaringTool) || byName(a.action, b.action),
  );

  const byEventType = tally(edges, (e) => e.event);
  const byEmissionSite = tally(edges, (e) => `${e.event}@${e.declaringTool}.${e.action}`);
  const byEventAndTool = tally(edges, (e) => `${e.event}@${e.declaringTool}`);

  /** One key's live verdict, plus whether either of its arms could ever fire. */
  const keyed = (groups, keyOf, count) => ({
    ...verdict(groups, count),
    arms: probeArms(edges, keyOf, count),
  });

  // The per-tier key is not a fourth grouping of edges — it is the per-type key
  // restricted to a subset of tiers. So it is reported as the tier breakdown of
  // the per-type population, which is what a tier-scoped rule would have to
  // choose from.
  const tierRows = new Map();
  for (const group of byEventType) {
    const annotation = raw.annotations[group.key];
    const tier = annotation === undefined ? '<unregistered>' : annotation.tier;
    let row = tierRows.get(tier);
    if (row === undefined) {
      row = { tier, events: [], zeroPrimaryEvents: [], multiPrimaryEventsByOwner: [] };
      tierRows.set(tier, row);
    }
    row.events.push(group.key);
    if (group.primaryOwners.size === 0) row.zeroPrimaryEvents.push(group.key);
    else if (group.primaryOwners.size > 1) row.multiPrimaryEventsByOwner.push(group.key);
  }
  const perTier = [...tierRows.values()]
    .map((row) => ({
      tier: row.tier,
      eventCount: row.events.length,
      events: row.events.sort(byName),
      zeroPrimaryEvents: row.zeroPrimaryEvents.sort(byName),
      multiPrimaryEventsByOwner: row.multiPrimaryEventsByOwner.sort(byName),
    }))
    .sort((a, b) => byName(a.tier, b.tier));

  const declaredEvents = new Set(edges.map((e) => e.event));
  const planDeclared = [...new Set(raw.planDeclared)].sort(byName);

  return {
    // What the numbers below are a function of. A reader who re-runs this and
    // sees different totals is looking at a moved catalog, not a flaky script.
    totals: {
      emissionEdges: edges.length,
      edgesCarryingRole: edges.filter((e) => e.role !== null).length,
      edgesCarryingOwner: edges.filter((e) => e.owner !== null).length,
      distinctEventsWithEdges: declaredEvents.size,
      distinctOwners: [...new Set(edges.map((e) => e.owner).filter((o) => o !== null))].sort(byName)
        .length,
      registeredEvents: Object.keys(raw.annotations).length,
      moduleEmitterRows: raw.moduleEmissions.length,
    },

    keys: {
      // K1 — the reading the criterion is written in, counting declarations.
      'per-event-type/primary-edges': keyed(byEventType, (e) => e.event, (g) => g.primaryEdges.length),
      // K2 — the same key, counting the accountable parties the criterion
      // actually names. This is the reading the word "owner" supports.
      'per-event-type/primary-owners': keyed(byEventType, (e) => e.event, (g) => g.primaryOwners.size),
      // K3 — one emission site is one occurrence's declared emitter. A site is
      // a single declaration, so this can only fail on a literally duplicated
      // one; whether that is expressible at all is the finding.
      'per-emission-site/primary-edges': keyed(
        byEmissionSite,
        (e) => `${e.event}@${e.declaringTool}.${e.action}`,
        (g) => g.primaryEdges.length,
      ),
      // K4 — the middle reading: one primary owner per event per declaring
      // tool. Collapses sibling actions of one tool without collapsing tools.
      'per-event-and-tool/primary-owners': keyed(
        byEventAndTool,
        (e) => `${e.event}@${e.declaringTool}`,
        (g) => g.primaryOwners.size,
      ),
    },

    // K5 — the tier-scoped rule, as the tier breakdown of the per-type
    // population. A tier-scoped gate has to pick its tiers from this table.
    perTier,

    // The other candidate population, and why it is empty. Zero overlap means a
    // gate keyed here would range over events no edge declares.
    planDeclaredPopulation: {
      events: planDeclared,
      coveredByAutoEmits: planDeclared.filter((e) => declaredEvents.has(e)).sort(byName),
      uncoveredByAutoEmits: planDeclared.filter((e) => !declaredEvents.has(e)).sort(byName),
      registeredInCatalog: planDeclared.filter((e) => raw.annotations[e] !== undefined).sort(byName),
    },

    // Emitters that are not actions carry no role and no owner. They are
    // reported because an event whose only emitter is a module has zero primary
    // owners for a structural reason, not a missing declaration — and the two
    // must not receive the same disposition.
    moduleEmitters: [...raw.moduleEmissions]
      .map((m) => ({
        ...m,
        alsoDeclaredByAnAction: declaredEvents.has(m.event),
      }))
      .sort((a, b) => byName(a.event, b.event) || byName(a.module, b.module)),

    // Events with an emission edge but no catalog registration. Empty is the
    // expected answer; a non-empty list would mean the per-type key ranges over
    // events the catalog does not know.
    unregisteredEmittedEvents: [...declaredEvents]
      .filter((e) => raw.annotations[e] === undefined)
      .sort(byName),
  };
}

// ─── Entry point ────────────────────────────────────────────────────────────

const rendered = `${JSON.stringify(measure(readRawFacts()), null, 2)}\n`;

if (process.argv.includes('--check')) {
  const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
  if (existing === rendered) {
    console.log(`primary-owner population census matches ${path.relative(ROOT, OUT)}`);
    process.exit(0);
  }
  console.error(
    existing === null
      ? `MISSING: ${path.relative(ROOT, OUT)} — run this script without --check to write it.`
      : `DRIFT: the catalog no longer matches ${path.relative(ROOT, OUT)}.\n` +
          'Re-run without --check, then re-read the decision this census supports: the\n' +
          'population under the chosen key has moved, so the disposition may be stale.',
  );
  process.exit(1);
}

fs.writeFileSync(OUT, rendered, 'utf8');
console.log(`wrote ${path.relative(ROOT, OUT)}`);
