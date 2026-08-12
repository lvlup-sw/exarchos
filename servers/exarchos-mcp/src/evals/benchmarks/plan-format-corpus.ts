// ─── Plan-Format Corpus Benchmark (#1636) ────────────────────────────────────
//
// Deterministic benchmark: run the REAL production classifiers over the corpus
// of stamped plan-format specs in `docs/specs/`, and measure how the delegation
// DECISION diverges across arms:
//
//   E  (exarchos, plan-honoring) — classifyTask WITH the planner's stamp (the fix)
//   H0 (true production)         — classifyTask({id,title}) — everything else is
//                                  stripped at the MCP boundary today (#1636)
//   H1 (heuristic ceiling)       — stamp stripped but files/testLayer retained
//   N  (native flat model)       — no per-task routing; one flat model (opus)
//
// Dimensions measured (no live agents — this is the deterministic backbone):
//   1. Model / agent selection  (scaffolder|implementer, haiku|opus, vs flat N)
//   2. Verification depth        (riskTier, boundaryTouching, gate sequence)
//
// Run:  npx tsx servers/exarchos-mcp/src/evals/benchmarks/plan-format-corpus.ts
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyTask,
  type TaskInput,
  type TaskClassification,
  type RiskTier,
} from '../../verbs/team/prepare-delegation.js';
import { parseTaskStamps, type TaskStamp } from '../../verbs/tasks/parse-task-stamps.js';
import { DEFAULT_SPEC_DIR } from '../../config/artifacts.js';

// ─── Corpus parsing ──────────────────────────────────────────────────────────
//
// The corpus is parsed by the PRODUCTION stamp parser (`parseTaskStamps`) — the
// same code that lifts stamps onto `prepare_delegation` — so the benchmark and
// the dispatch path can never drift.

/** A parsed corpus task = a plan stamp plus the spec it came from. */
type CorpusTask = TaskStamp & { readonly spec: string };

// ─── Arms ────────────────────────────────────────────────────────────────────

/** Build the TaskInput for the plan-honoring arm (E): includes the stamp. */
function stampedInput(t: CorpusTask): TaskInput {
  return {
    id: t.id,
    title: t.title,
    files: t.files,
    blockedBy: t.blockedBy,
    ...(t.testLayer ? { testLayer: t.testLayer } : {}),
    ...(t.riskTier ? { riskTier: t.riskTier } : {}),
    ...(t.boundaryTouching !== undefined ? { boundaryTouching: t.boundaryTouching } : {}),
  };
}

/**
 * Heuristic-with-context arm (H1): stamp stripped, but files/testLayer/deps
 * retained. This is the heuristic's CEILING — the best it could do if a diligent
 * orchestrator forwarded task context (which the current registry schema does
 * NOT accept). Isolates "heuristic vs plan" holding context constant.
 */
function strippedInput(t: CorpusTask): TaskInput {
  return {
    id: t.id,
    title: t.title,
    files: t.files,
    blockedBy: t.blockedBy,
    ...(t.testLayer ? { testLayer: t.testLayer } : {}),
    // riskTier / boundaryTouching intentionally omitted — force heuristic derivation.
  };
}

/**
 * True-production arm (H0): `{ id, title }` ONLY. This is what actually reaches
 * `handlePrepareDelegation` today — `registry.ts:1441` registers
 * `tasks: z.array(z.object({ id, title }))`, so Zod strips files/testLayer/deps
 * AND the planner stamp before the handler runs, and the delegate skill only
 * sends `{id, title, modules}`. This is the real #1636 dispatched behavior.
 */
function trueProductionInput(t: CorpusTask): TaskInput {
  return { id: t.id, title: t.title };
}

const TIER_RANK: Record<RiskTier, number> = { low: 0, medium: 1, high: 2 };

interface Row {
  readonly spec: string;
  readonly id: string;
  readonly title: string;
  readonly stamped: boolean;
  readonly boundaryStamped: boolean;
  readonly fileCount: number;
  readonly E: TaskClassification; // plan-honoring (the fix)
  readonly H: TaskClassification; // H1: heuristic ceiling (files+testLayer, no stamp)
  readonly H0: TaskClassification; // true production ({id,title} only)
}

// ─── Main ────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../../../');
const SPECS_DIR = path.join(REPO_ROOT, DEFAULT_SPEC_DIR);

/** Load every spec, parse via the production parser, keep those with a stamp. */
function loadCorpus(): { specPaths: string[]; tasks: CorpusTask[] } {
  const all = fs
    .readdirSync(SPECS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => path.join(SPECS_DIR, f));
  const specPaths: string[] = [];
  const tasks: CorpusTask[] = [];
  for (const p of all) {
    const parsed = parseTaskStamps(fs.readFileSync(p, 'utf-8'));
    const stamped = parsed.filter((t) => t.riskTier !== undefined);
    if (stamped.length === 0) continue;
    specPaths.push(p);
    for (const t of parsed) tasks.push({ ...t, spec: path.basename(p) });
  }
  return { specPaths, tasks };
}

function pct(n: number, d: number): string {
  return d === 0 ? '0%' : `${((100 * n) / d).toFixed(0)}%`;
}

function main(): void {
  const { specPaths, tasks: parsed } = loadCorpus();
  const rows: Row[] = parsed.map((t) => ({
    spec: t.spec,
    id: t.id,
    title: t.title,
    stamped: t.riskTier !== undefined,
    boundaryStamped: t.boundaryTouching !== undefined,
    fileCount: t.files.length,
    E: classifyTask(stampedInput(t)),
    H: classifyTask(strippedInput(t)),
    H0: classifyTask(trueProductionInput(t)),
  }));

  // Only tasks that actually carry a planner riskTier stamp are meaningful for
  // the divergence dimension (the corpus is authored to always stamp riskTier).
  const stampedRows = rows.filter((r) => r.stamped);

  // ── Dimension 2: verification-depth divergence (E vs H) ──
  let tierMatch = 0;
  let tierUnder = 0; // heuristic weaker than plan → UNDER-verified (the #1636 harm)
  let tierOver = 0; // heuristic stronger than plan → wasted verification
  const confusion: Record<string, number> = {};
  let boundaryLost = 0; // plan says boundary, heuristic misses it → steer dropped
  let boundaryPhantom = 0; // heuristic says boundary, plan didn't
  let integrationRungLost = 0; // E has check_integration_suite, H doesn't
  for (const r of stampedRows) {
    const pt = r.E.riskTier;
    const ht = r.H.riskTier;
    const key = `${pt}→${ht}`;
    confusion[key] = (confusion[key] ?? 0) + 1;
    if (pt === ht) tierMatch++;
    else if (TIER_RANK[ht] < TIER_RANK[pt]) tierUnder++;
    else tierOver++;
    if (r.E.boundaryTouching && !r.H.boundaryTouching) boundaryLost++;
    if (!r.E.boundaryTouching && r.H.boundaryTouching) boundaryPhantom++;
    const eHasIntegration = r.E.verificationSequence.includes('check_integration_suite');
    const hHasIntegration = r.H.verificationSequence.includes('check_integration_suite');
    if (eHasIntegration && !hHasIntegration) integrationRungLost++;
  }

  // ── Same divergence, but against the TRUE-production arm (H0: {id,title}) ──
  // This is what actually ships today. H1 above is the heuristic's ceiling.
  let tierMatch0 = 0;
  let tierUnder0 = 0;
  let tierOver0 = 0;
  let boundaryLost0 = 0;
  let integrationRungLost0 = 0;
  for (const r of stampedRows) {
    const pt = r.E.riskTier;
    const ht = r.H0.riskTier;
    if (pt === ht) tierMatch0++;
    else if (TIER_RANK[ht] < TIER_RANK[pt]) tierUnder0++;
    else tierOver0++;
    if (r.E.boundaryTouching && !r.H0.boundaryTouching) boundaryLost0++;
    if (
      r.E.verificationSequence.includes('check_integration_suite') &&
      !r.H0.verificationSequence.includes('check_integration_suite')
    ) {
      integrationRungLost0++;
    }
  }

  // ── Dimension 1: model / agent selection ──
  const modelDist: Record<string, number> = {};
  const agentDist: Record<string, number> = {};
  // model × tier cross-tab (does model track blast-radius tier?)
  const modelByTier: Record<string, Record<string, number>> = {
    low: {},
    medium: {},
    high: {},
  };
  let highTierCheapModel = 0; // high-risk task routed to haiku (under-powered?)
  let lowTierExpensiveModel = 0; // low-risk task routed to opus (over-powered?)
  const NATIVE_FLAT_MODEL = 'opus'; // native default (session model / defaultModel)
  let cheaperThanNative = 0; // E routes below the native flat model
  for (const r of stampedRows) {
    modelDist[r.E.recommendedModel] = (modelDist[r.E.recommendedModel] ?? 0) + 1;
    agentDist[r.E.recommendedAgent] = (agentDist[r.E.recommendedAgent] ?? 0) + 1;
    const tierDist = (modelByTier[r.E.riskTier] ??= {});
    tierDist[r.E.recommendedModel] = (tierDist[r.E.recommendedModel] ?? 0) + 1;
    if (r.E.riskTier === 'high' && r.E.recommendedModel === 'haiku') highTierCheapModel++;
    if (r.E.riskTier === 'low' && r.E.recommendedModel === 'opus') lowTierExpensiveModel++;
    if (r.E.recommendedModel !== NATIVE_FLAT_MODEL && r.E.recommendedModel === 'haiku') {
      cheaperThanNative++;
    }
  }

  const n = stampedRows.length;

  // ── Emit markdown report ──
  const out: string[] = [];
  out.push('# Plan-Format Corpus Benchmark (#1636) — deterministic arm');
  out.push('');
  out.push(
    `Runs the production \`classifyTask\` / \`renderImplementerPrompt\` over every stamped ` +
      `plan-format spec in \`docs/specs/\`. Arms: **E** (exarchos, plan-honoring — the fix) · ` +
      `**H0** (true production, \`{id,title}\` only — the current #1636 dispatched behavior) · ` +
      `**H1** (heuristic ceiling, files+testLayer but no stamp) · **N** (native flat model).`,
  );
  out.push('');
  out.push(
    '> ⚠️ **PROVISIONAL — models the decision, does not run the binary (#1670).** This calls the ' +
      'pure `classifyTask` directly; it does NOT go through the MCP schema/CLI/binary, and the E-arm ' +
      'numbers do NOT depend on the #1636 fix (`deriveRiskTier` already honored an explicit tier — the ' +
      'bug was that stamps never *reached* it). The `N` "native flat opus" model is an unvalidated ' +
      'assumption, not measured native behavior. Treat as directional pending the executed test in #1670.',
  );
  out.push('');
  out.push('## Corpus');
  out.push('');
  out.push(`- Stamped specs: **${specPaths.length}**`);
  out.push(`- Tasks parsed: **${rows.length}**`);
  out.push(`- Tasks carrying a \`riskTier\` stamp: **${n}** (${pct(n, rows.length)})`);
  out.push(
    `- Tasks carrying an explicit \`boundaryTouching\` stamp: **${rows.filter((r) => r.boundaryStamped).length}**`,
  );
  out.push('');
  out.push('## Dimension 1 — model & agent selection (arm E)');
  out.push('');
  out.push('Exarchos routes model via the tier policy (`resolveModelForTask` keyed on the resolved `riskTier`; planner stamps win per #1669), applied on top of `classifyTaskCore` (scaffolding-keyword / testLayer / deps / file-count), which still selects the agent lane. Defaults (`tierModels`): `low→haiku`, `medium→sonnet`, `high→opus` (#1672).');
  out.push('');
  out.push(`- Agent mix: ${JSON.stringify(agentDist)}`);
  out.push(`- Model mix: ${JSON.stringify(modelDist)}`);
  out.push(`- **vs native flat \`${NATIVE_FLAT_MODEL}\`:** ${cheaperThanNative}/${n} tasks (${pct(cheaperThanNative, n)}) routed to the cheaper \`haiku\` — the cost saving from per-task routing.`);
  out.push('');
  out.push('Model × risk-tier cross-tab (does the model track blast radius?):');
  out.push('');
  out.push('| risk tier | haiku | sonnet | opus |');
  out.push('|---|---|---|---|');
  for (const tier of ['low', 'medium', 'high'] as const) {
    const m = modelByTier[tier] ?? {};
    out.push(`| ${tier} | ${m.haiku ?? 0} | ${m.sonnet ?? 0} | ${m.opus ?? 0} |`);
  }
  out.push('');
  out.push(`- ⚠️ high-tier tasks on the cheap \`haiku\` model (possible under-powering): **${highTierCheapModel}**`);
  out.push(`- ⚠️ low-tier tasks on the expensive \`opus\` model (possible over-powering): **${lowTierExpensiveModel}**`);
  out.push('');
  out.push('## Dimension 2 — verification depth');
  out.push('');
  out.push('### E (plan-honoring) vs H0 (true production — `{id,title}` only) — the actual #1636 harm');
  out.push('');
  out.push('`registry.ts:1441` registers `tasks: z.array(z.object({ id, title }))`, so today every task reaches the classifier as `{id, title}` — no stamp, no files, no testLayer. This is what actually ships.');
  out.push('');
  out.push(`- Tier **match**: **${tierMatch0}/${n}** (${pct(tierMatch0, n)})`);
  out.push(`- Tier **UNDER-provisioned** (H0 weaker than plan): **${tierUnder0}/${n}** (${pct(tierUnder0, n)})  ← the harm`);
  out.push(`- Tier over-provisioned: **${tierOver0}/${n}** (${pct(tierOver0, n)})`);
  out.push(`- **\`check_integration_suite\` rung lost**: **${integrationRungLost0}/${n}** (${pct(integrationRungLost0, n)}) — every planner-\`high\` task ships without the integration rung`);
  out.push(`- **Boundary mock-steer lost**: **${boundaryLost0}/${n}** (${pct(boundaryLost0, n)})`);
  out.push('');
  out.push('### E (plan-honoring) vs H1 (heuristic ceiling — files+testLayer, no stamp)');
  out.push('');
  out.push('Isolates the heuristic quality itself: even IF the orchestrator forwarded full task context (which the registry schema forbids), how well does the keyword/glob heuristic recover the plan tier?');
  out.push('');
  out.push(`- Tier **match** (H agrees with plan): **${tierMatch}/${n}** (${pct(tierMatch, n)})`);
  out.push(`- Tier **UNDER-provisioned** by heuristic (H weaker than plan): **${tierUnder}/${n}** (${pct(tierUnder, n)})  ← the harm`);
  out.push(`- Tier **over-provisioned** by heuristic (H stronger than plan): **${tierOver}/${n}** (${pct(tierOver, n)})`);
  out.push(`- **\`check_integration_suite\` rung lost** (E has it, H doesn't): **${integrationRungLost}/${n}** (${pct(integrationRungLost, n)})`);
  out.push(`- **Boundary mock-steer lost** (plan boundary=true, heuristic=false): **${boundaryLost}/${n}** (${pct(boundaryLost, n)})`);
  out.push(`- Boundary phantom (heuristic adds boundary the plan didn't): **${boundaryPhantom}/${n}**`);
  out.push('');
  out.push('Tier confusion (`plan→heuristic`):');
  out.push('');
  out.push('| plan → heuristic | count |');
  out.push('|---|---|');
  for (const [k, v] of Object.entries(confusion).sort((a, b) => b[1] - a[1])) {
    const [pt, ht] = k.split('→');
    const flag = TIER_RANK[ht as RiskTier] < TIER_RANK[pt as RiskTier] ? ' ⚠️ under' : '';
    out.push(`| ${k}${flag} | ${v} |`);
  }
  out.push('');
  out.push('## Per-task detail');
  out.push('');
  out.push('| spec | task | files | plan tier | heur tier | Δtier | plan bnd | heur bnd | agent | model |');
  out.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of stampedRows) {
    const under = TIER_RANK[r.H.riskTier] < TIER_RANK[r.E.riskTier];
    const over = TIER_RANK[r.H.riskTier] > TIER_RANK[r.E.riskTier];
    const delta = under ? '⚠️ under' : over ? 'over' : '=';
    const bndLost = r.E.boundaryTouching && !r.H.boundaryTouching ? ' ⚠️' : '';
    out.push(
      `| ${r.spec.replace(/^\d{4}-\d\d-\d\d-/, '').replace(/\.md$/, '')} | ${r.id} | ${r.fileCount} | ${r.E.riskTier} | ${r.H.riskTier} | ${delta} | ${r.E.boundaryTouching}${bndLost} | ${r.H.boundaryTouching} | ${r.E.recommendedAgent} | ${r.E.recommendedModel} |`,
    );
  }
  out.push('');

  const report = out.join('\n');
  const outDir = path.join(REPO_ROOT, 'docs/evals');
  fs.mkdirSync(outDir, { recursive: true });
  const mdPath = path.join(outDir, '2026-07-09-1636-plan-format-corpus.md');
  const jsonPath = path.join(outDir, '2026-07-09-1636-plan-format-corpus.json');
  fs.writeFileSync(mdPath, report);
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        corpus: { specs: specPaths.map((p) => path.basename(p)), tasks: rows.length, stamped: n },
        dimension1_model: { agentDist, modelDist, modelByTier, highTierCheapModel, lowTierExpensiveModel, cheaperThanNative },
        dimension2_verification: {
          vsTrueProduction_H0: { tierMatch: tierMatch0, tierUnder: tierUnder0, tierOver: tierOver0, integrationRungLost: integrationRungLost0, boundaryLost: boundaryLost0 },
          vsHeuristicCeiling_H1: { tierMatch, tierUnder, tierOver, integrationRungLost, boundaryLost, boundaryPhantom, confusion },
        },
        rows: stampedRows.map((r) => ({
          spec: r.spec,
          id: r.id,
          title: r.title,
          fileCount: r.fileCount,
          planTier: r.E.riskTier,
          heuristicTier: r.H.riskTier,
          planBoundary: r.E.boundaryTouching,
          heuristicBoundary: r.H.boundaryTouching,
          agent: r.E.recommendedAgent,
          model: r.E.recommendedModel,
          eGates: r.E.verificationSequence,
          hGates: r.H.verificationSequence,
        })),
      },
      null,
      2,
    ),
  );

  // Console summary
  process.stdout.write(report + '\n');
  process.stdout.write(`\n[written] ${path.relative(REPO_ROOT, mdPath)}\n`);
  process.stdout.write(`[written] ${path.relative(REPO_ROOT, jsonPath)}\n`);
}

main();
