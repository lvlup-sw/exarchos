// ─── Exp 2 · Emit the measured native-baseline CSV from the captured fixtures ──
//
// Reduces the two real `claude -p` delegation transcripts (fixtures/) to the
// committed raw-data table `../data/2026-07-09/exp2-native-baseline.csv`, one row
// per observed subagent, each **stamped through the Task-001 provenance helper**
// (`stampProvenance`, which throws if any pin is missing). Deterministic and
// side-effect-free apart from the single file write — no clock, no network — so
// the committed CSV is regenerable and verifiable in CI (harness.test.ts already
// pins the fixtures; run-underspec/grade pin the other two experiments' CSVs).
//
// This closes the reproducibility gap the CSV would otherwise carry: its values
// are DERIVED from the fixtures here, not hand-authored, and the provenance
// columns are produced by the same helper every other #1670 artifact uses.
//
//   tsx docs/evals/native-baseline/emit-baseline-csv.ts          # regenerate
//   tsx docs/evals/native-baseline/emit-baseline-csv.ts --check  # verify no drift

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  parseStreamJson,
  buildNativeBaselineRecord,
  type MeasuredNativeBaseline,
} from './harness.js';
import { stampProvenance, type Provenance } from '../../../servers/exarchos-mcp/src/evals/provenance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');
const OUT = path.resolve(__dirname, '../data/2026-07-09/exp2-native-baseline.csv');

/** The one shared plan both runs delegated over (a minimal 3-task proof-of-mechanics). */
const SPEC_REF = 'synthetic-3task-plan';

/** Provenance pin for the native run: the `claude` CLI that produced the transcript
 * (binaryTag) and the harness commit that captured + parses it (gitSha). */
const PROVENANCE: Provenance = {
  binaryTag: 'claude-code-2.1.206',
  gitSha: 'b7dd0fce',
  modelIds: ['claude-sonnet-5'],
  date: '2026-07-09',
};

interface RunSpec {
  readonly run: string;
  readonly variant: string;
  readonly fixture: string;
}

const RUNS: readonly RunSpec[] = [
  { run: 'r1', variant: 'A-streamed', fixture: 'delegation-sonnet-3subagents.jsonl' },
  { run: 'r2', variant: 'B-notification-only', fixture: 'delegation-sonnet-notification-only.jsonl' },
];

const HEADER = [
  'run', 'variant', 'specRef', 'subagentType', 'description', 'model', 'modelSource',
  'totalTokens', 'inputTokens', 'outputTokens', 'toolUses', 'status', 'runSubagents',
  'runDistinctModelCount', 'runInheritsSingleModel', 'runAttributionMode', 'runSessionCostUsd',
  'source', 'binaryTag', 'gitSha', 'date', 'modelIds', 'note',
].join(',');

const NOTE: Record<string, string> = {
  assistant: 'per-message model read directly off streamed assistant message',
  'session-single': 'subagent assistant not streamed; model inferred from sole session model (result.modelUsage)',
  unresolved: 'model unresolved — not attributed',
};

/** Trim floating-point noise deterministically (e.g. 0.5174221499999999 → 0.51742215). */
function num(n: number | undefined): string {
  return n === undefined ? '' : String(Number(n.toFixed(8)));
}

/** Minimal CSV field quoting — wrap in double-quotes, doubling embedded quotes. */
function q(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

function buildCsv(): string {
  const rows: string[] = [HEADER];
  for (const { run, variant, fixture } of RUNS) {
    const text = fs.readFileSync(path.join(FIXTURES, fixture), 'utf-8');
    const { events, malformed } = parseStreamJson(text);
    if (malformed > 0) throw new Error(`${fixture}: ${malformed} malformed line(s)`);
    const record = buildNativeBaselineRecord({ events, specRef: SPEC_REF });
    if (record.outcome !== 'measured') {
      throw new Error(`${fixture}: expected a measured record, got ${record.outcome}`);
    }
    const r = record as MeasuredNativeBaseline;
    const dist = r.modelDistribution;
    const cost = r.sessionModelUsage[r.subagents[0]?.model ?? '']?.costUSD;
    for (const s of r.subagents) {
      // Stamp through the Task-001 helper: throws unless every pin is present.
      const { provenance } = stampProvenance({ run, subagent: s.toolUseId }, PROVENANCE);
      rows.push([
        run, variant, SPEC_REF, s.subagentType ?? 'unknown', q(s.description ?? ''),
        s.model ?? 'unknown', s.modelSource,
        String(s.tokens.total ?? ''), String(s.tokens.input), String(s.tokens.output),
        String(s.toolUses), s.status ?? '', String(r.subagents.length),
        String(dist.distinctModelCount), String(dist.inheritsSingleModel), dist.attributionMode,
        num(cost), 'measured', provenance.binaryTag, provenance.gitSha, provenance.date,
        provenance.modelIds.join('|'), NOTE[s.modelSource] ?? '',
      ].join(','));
    }
  }
  return rows.join('\n') + '\n';
}

function main(): void {
  const csv = buildCsv();
  if (process.argv.includes('--check')) {
    const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf-8') : '';
    if (existing !== csv) {
      process.stderr.write(`DRIFT: ${path.relative(process.cwd(), OUT)} differs from the fixtures — re-run without --check.\n`);
      process.exit(1);
    }
    process.stdout.write('OK — committed CSV matches the fixtures.\n');
    return;
  }
  fs.writeFileSync(OUT, csv);
  process.stdout.write(`wrote ${path.relative(process.cwd(), OUT)} (${csv.split('\n').length - 2} rows)\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invokedPath === import.meta.url) main();
