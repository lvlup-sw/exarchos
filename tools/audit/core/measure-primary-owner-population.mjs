// Counts the primary-owner population of the emission catalog under each candidate key.
// The census does not judge. It reports zero-primary, unowned-primary and multi-primary
// rows apart, because each needs a different repair. It also counts primary edges and
// distinct primary owners apart. Many gate actions that each declare
// `owner: 'orchestrate'` are many edges but one owner.
//
// The output holds no timestamp and no commit sha. A second run on the same tree
// gives the same bytes, so `--check` reports only a change in the catalog.
//
// Usage:
//   node tools/audit/core/measure-primary-owner-population.mjs           # write
//   node tools/audit/core/measure-primary-owner-population.mjs --check   # verify

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = path.join(ROOT, 'tools/audit/core/primary-owner-population.json');
/**
 * The expected size of the per-event-type population.
 * It must equal `PRIMARY_OWNER_POPULATION_FLOOR` in `src/events/registration-validate.ts`.
 */
const PRIMARY_OWNER_POPULATION_FLOOR = 76;
const CENSUS_MARKER = '<<<CENSUS>>>';

/**
 * The extractor script. It imports the live registry as values and does not parse source, so the census agrees with what boots.
 * The registry loads the SQLite substrate, so the script runs in a child process through the `tsx` CLI of the workspace.
 */
const EXTRACT = `
import { TOOL_REGISTRY } from './src/registry.js';
import { contractEmissionsOf } from './src/registry/action-contract.js';
import { EVENT_ANNOTATIONS } from './src/events/event-annotations.js';
import { MODULE_EMISSIONS } from './src/events/module-emissions.js';
import { VCS_LEDGER_EMISSIONS } from './src/vcs/mutation-owner.js';
import { PROMOTION_EXECUTED } from './src/install/atomic-promotion.js';

const edges = [];
for (const tool of TOOL_REGISTRY) {
  for (const action of tool.actions) {
    for (const emission of contractEmissionsOf(action)) {
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
  '${CENSUS_MARKER}' +
    JSON.stringify({
      edges,
      annotations,
      moduleEmissions: MODULE_EMISSIONS.map((m) => ({
        event: m.event,
        module: m.module,
        trigger: m.trigger,
      })),
      planDeclared,
    }) +
    '${CENSUS_MARKER}',
);
`;

function readRawFacts() {
  const tmp = path.join(ROOT, `.tmp-primary-owner-census-${randomUUID()}.mts`);
  const tsxCli = path.join(ROOT, 'node_modules/tsx/dist/cli.mjs');
  fs.writeFileSync(tmp, EXTRACT, 'utf8');
  try {
    const out = execFileSync(process.execPath, [tsxCli, tmp], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const marker = out.indexOf(CENSUS_MARKER);
    if (marker === -1) throw new Error(`census extractor produced no payload:\n${out}`);
    const end = out.indexOf(CENSUS_MARKER, marker + CENSUS_MARKER.length);
    if (end === -1) throw new Error(`census extractor payload was truncated:\n${out}`);
    return JSON.parse(out.slice(marker + CENSUS_MARKER.length, end));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Groups the edges by a key and collects the primary edges and the distinct primary owners of each group.
 * A group whose edges all name one owner has one owner and many edges.
 */
function tally(edges, keyOf) {
  const groups = new Map();
  for (const edge of edges) {
    const key = keyOf(edge);
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        key,
        edges: [],
        primaryEdges: [],
        primaryOwners: new Set(),
        unattributedPrimaryEdges: [],
      };
      groups.set(key, group);
    }
    group.edges.push(edge);
    if (edge.role === 'primary') {
      group.primaryEdges.push(edge);
      if (edge.owner === null) group.unattributedPrimaryEdges.push(edge);
      else group.primaryOwners.add(edge.owner);
    }
  }
  return [...groups.values()].sort((a, b) => byName(a.key, b.key));
}

/**
 * Splits a tallied population into satisfying, zero-primary, unowned-primary and multi-primary rows.
 * The violation arms stay separate in the output, because each needs a different repair.
 * Only the keys of the satisfying rows go into the output, because a disposition acts on the violation rows.
 */
function verdict(groups, count) {
  const satisfied = [];
  const zeroPrimary = [];
  const unownedPrimary = [];
  const multiPrimary = [];
  for (const group of groups) {
    const n = count(group);
    const row = {
      key: group.key,
      primaryEdges: group.primaryEdges.length,
      primaryOwners: [...group.primaryOwners].sort(byName),
      unattributedPrimaryEdges: group.unattributedPrimaryEdges.length,
      declaringEdges: group.edges.length,
      declaredBy: group.edges
        .map((e) => `${e.declaringTool}.${e.action}`)
        .sort(byName)
        .filter((id, i, all) => all.indexOf(id) === i),
    };
    if (n === 1) satisfied.push(row);
    else if (n === 0 && group.unattributedPrimaryEdges.length > 0) unownedPrimary.push(row);
    else if (n === 0) zeroPrimary.push(row);
    else multiPrimary.push(row);
  }
  return {
    populationSize: groups.length,
    satisfyingCount: satisfied.length,
    zeroPrimaryCount: zeroPrimary.length,
    unownedPrimaryCount: unownedPrimary.length,
    multiPrimaryCount: multiPrimary.length,
    zeroPrimary,
    unownedPrimary,
    multiPrimary,
    satisfyingKeys: satisfied.map((row) => row.key),
  };
}

/**
 * Reports whether each failure arm of a key can fire.
 * A key with no live violation can still be unable to fail, so the probe applies two drifts to a copy of the edges:
 * - MULTI: an action in a foreign tool also claims the primary role for an owned event.
 * - ZERO: the only primary edge of an event becomes `recovery`.
 *
 * The MULTI arm reads only the count of the seeded group, because a scan of the whole population can find an existing violation.
 * This probe works over data. It does not prove that a shipped check rejects the drift.
 */
function probeArms(edges, keyOf, count) {
  const subject = edges.find((e) => e.role === 'primary');
  if (subject === undefined) {
    return {
      multiArmReachable: false,
      zeroArmReachable: false,
      probedWith: { multi: null, zero: null },
    };
  }

  const groupCount = (population, key) => {
    const group = tally(population, keyOf).find((g) => g.key === key);
    return group === undefined ? null : count(group);
  };

  const foreign = {
    ...subject,
    action: `${subject.action}__seeded`,
    declaringTool: '__seeded_tool',
    owner: '__seeded_owner',
  };
  const seededKey = keyOf(foreign);
  const before = groupCount(edges, seededKey) ?? 0;
  const after = groupCount([...edges, foreign], seededKey) ?? 0;
  const multiArmReachable = after > 1 && after > before;

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

/**
 * Builds the census document from the raw facts.
 * The four candidate keys are the event type (counted by primary edges and by primary owners), the emission site, and the pair of event and declaring tool.
 * The per-tier rows split the per-event-type population by tier, and are not a fifth key.
 * The census lists module emitters apart, because they carry no role and no owner.
 * An empty `unregisteredEmittedEvents` list is the expected result.
 */
function measure(raw) {
  const edges = [...raw.edges].sort(
    (a, b) =>
      byName(a.event, b.event) || byName(a.declaringTool, b.declaringTool) || byName(a.action, b.action),
  );

  const byEventType = tally(edges, (e) => e.event);
  const byEmissionSite = tally(edges, (e) => `${e.event}@${e.declaringTool}.${e.action}`);
  const byEventAndTool = tally(edges, (e) => `${e.event}@${e.declaringTool}`);

  const keyed = (groups, keyOf, count) => ({
    ...verdict(groups, count),
    arms: probeArms(edges, keyOf, count),
  });

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
      'per-event-type/primary-edges': keyed(byEventType, (e) => e.event, (g) => g.primaryEdges.length),
      'per-event-type/primary-owners': keyed(byEventType, (e) => e.event, (g) => g.primaryOwners.size),
      'per-emission-site/primary-edges': keyed(
        byEmissionSite,
        (e) => `${e.event}@${e.declaringTool}.${e.action}`,
        (g) => g.primaryEdges.length,
      ),
      'per-event-and-tool/primary-owners': keyed(
        byEventAndTool,
        (e) => `${e.event}@${e.declaringTool}`,
        (g) => g.primaryOwners.size,
      ),
    },

    perTier,

    planDeclaredPopulation: {
      events: planDeclared,
      coveredByAutoEmits: planDeclared.filter((e) => declaredEvents.has(e)).sort(byName),
      uncoveredByAutoEmits: planDeclared.filter((e) => !declaredEvents.has(e)).sort(byName),
      registeredInCatalog: planDeclared.filter((e) => raw.annotations[e] !== undefined).sort(byName),
    },

    moduleEmitters: [...raw.moduleEmissions]
      .map((m) => ({
        ...m,
        alsoDeclaredByAnAction: declaredEvents.has(m.event),
      }))
      .sort((a, b) => byName(a.event, b.event) || byName(a.module, b.module)),

    unregisteredEmittedEvents: [...declaredEvents]
      .filter((e) => raw.annotations[e] === undefined)
      .sort(byName),
  };
}

/**
 * Throws unless the per-event-type population equals `PRIMARY_OWNER_POPULATION_FLOOR`.
 * A population of zero gets its own message, because it shows a broken extractor and not a smaller catalog.
 */
function assertPopulationFloor(measured) {
  const population = measured.keys['per-event-type/primary-owners'].populationSize;
  if (population === PRIMARY_OWNER_POPULATION_FLOOR) return;

  if (population === 0) {
    throw new Error(
      'primary-owner census resolved ZERO edges over a non-empty registry. That is a broken ' +
        'extractor, not a shrunken catalog: `contractEmissionsOf` no longer matches how the ' +
        'registry carries emissions. Fix the accessor in EXTRACT before touching any constant — ' +
        'compare against `declaredEmissionEdges` in src/events/registration-validate.ts, which ' +
        'is the shipped reader of the same declarations.',
    );
  }

  throw new Error(
    `PRIMARY_OWNER_POPULATION_FLOOR drift: census reports ${population}, ` +
      `script constant is ${PRIMARY_OWNER_POPULATION_FLOOR}; reconcile with ` +
      'src/events/registration-validate.ts PRIMARY_OWNER_POPULATION_FLOOR.',
  );
}

const measured = measure(readRawFacts());
assertPopulationFloor(measured);
const rendered = `${JSON.stringify(measured, null, 2)}\n`;

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
