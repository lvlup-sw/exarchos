/**
 * Plan-format corpus benchmark. It runs the production classifier over every stamped spec in the spec directory.
 * Then it compares the delegation decision across these arms:
 *
 * - E (plan-honoring): `classifyTask` with the stamp of the planner.
 * - H0 (bare): `classifyTask` with `{ id, title }` and nothing more.
 * - H1 (heuristic ceiling): no stamp, but the files, the test layer and the dependencies stay.
 * - N (native flat model): one model, `opus`, for every task.
 *
 * It measures the model and agent selection, and the verification depth. It runs no live agent.
 * It writes a Markdown report and a JSON report under `tests/evals/`. Run it with `npm run bench:plan-format`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyTask,
  type TaskInput,
  type TaskClassification,
  type RiskTier,
} from '../../../../src/verbs/team/prepare-delegation.js';
import { parseTaskStamps, type TaskStamp } from '../../../../src/verbs/tasks/parse-task-stamps.js';
import { DEFAULT_SPEC_DIR } from '../../../../src/config/artifacts.js';

/**
 * A plan stamp plus the name of its spec. The production parser `parseTaskStamps` reads it,
 * and `prepare_delegation` uses the same parser, so the benchmark and the dispatch path agree.
 */
type CorpusTask = TaskStamp & { readonly spec: string };

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
 * Heuristic-ceiling arm (H1): no stamp, but the files, the test layer and the dependencies stay.
 * The heuristic derives the risk tier and the boundary flag, so this arm measures the heuristic against the plan with the same context.
 */
function strippedInput(t: CorpusTask): TaskInput {
  return {
    id: t.id,
    title: t.title,
    files: t.files,
    blockedBy: t.blockedBy,
    ...(t.testLayer ? { testLayer: t.testLayer } : {}),
  };
}

/** Bare arm (H0): `{ id, title }` and nothing more, as from a caller that sends no stamp and no task context. */
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
  /** The plan-honoring arm. */
  readonly E: TaskClassification;
  /** The heuristic-ceiling arm, H1. */
  readonly H: TaskClassification;
  /** The bare arm. */
  readonly H0: TaskClassification;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');
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

/**
 * Classifies every corpus task in each arm and writes the reports. Only the tasks with a `riskTier` stamp enter the comparison.
 * A tier under the plan tier is the harm, because the task gets less verification than the plan asks for.
 * `NATIVE_FLAT_MODEL` stands for the native default model. `cheaperThanNative` counts the tasks that arm E routes to `haiku`.
 */
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

  const stampedRows = rows.filter((r) => r.stamped);

  let tierMatch = 0;
  let tierUnder = 0;
  let tierOver = 0;
  const confusion: Record<string, number> = {};
  let boundaryLost = 0;
  let boundaryPhantom = 0;
  let integrationRungLost = 0;
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

  const modelDist: Record<string, number> = {};
  const agentDist: Record<string, number> = {};
  const modelByTier: Record<string, Record<string, number>> = {
    low: {},
    medium: {},
    high: {},
  };
  let highTierCheapModel = 0;
  let lowTierExpensiveModel = 0;
  const NATIVE_FLAT_MODEL = 'opus';
  let cheaperThanNative = 0;
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
  const outDir = path.join(REPO_ROOT, 'tests/evals');
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

  process.stdout.write(report + '\n');
  process.stdout.write(`\n[written] ${path.relative(REPO_ROOT, mdPath)}\n`);
  process.stdout.write(`[written] ${path.relative(REPO_ROOT, jsonPath)}\n`);
}

main();
