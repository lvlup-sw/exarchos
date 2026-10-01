/**
 * Security scan gate. It scans the added lines of a unified diff for common security anti-patterns,
 * such as hardcoded secrets and `eval()`.
 */

import { createHash } from 'node:crypto';

import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { createEvidenceSubject } from '../../workflow/admission/evidence-subject.js';
import { runPhaseGateWithEvidence } from './gate-runner.js';
import { requireGateEvent, sameOperationGateKey } from './gate-utils.js';

interface SecurityScanArgs {
  readonly featureId: string;
  readonly diffContent?: string;
}

export interface SecurityFinding {
  readonly file: string;
  readonly line: number;
  readonly pattern: string;
  readonly severity: 'HIGH' | 'MEDIUM';
  readonly context: string;
}

interface SecurityScanResult {
  readonly passed: boolean;
  readonly findingCount: number;
  readonly findings: readonly SecurityFinding[];
  readonly report: string;
}

interface SecurityPattern {
  readonly name: string;
  readonly severity: 'HIGH' | 'MEDIUM';
  readonly test: (line: string) => boolean;
}

const SECURITY_PATTERNS: readonly SecurityPattern[] = [
  {
    name: 'Hardcoded secret/credential',
    severity: 'HIGH',
    test: (line: string) =>
      /(?:API_KEY|SECRET|PASSWORD|TOKEN|PRIVATE_KEY)\s*=\s*["']/i.test(line),
  },
  {
    name: 'eval() usage',
    severity: 'HIGH',
    test: (line: string) => /\beval\s*\(/.test(line),
  },
  {
    name: 'SQL string concatenation',
    severity: 'HIGH',
    test: (line: string) =>
      /"SELECT\b.*"\s*\+|`SELECT\b.*\$\{/i.test(line),
  },
  {
    name: 'innerHTML assignment',
    severity: 'MEDIUM',
    test: (line: string) => /\.innerHTML\s*=/.test(line),
  },
  {
    name: 'dangerouslySetInnerHTML usage',
    severity: 'MEDIUM',
    test: (line: string) => /dangerouslySetInnerHTML/.test(line),
  },
  {
    name: 'child_process.exec with variable input',
    severity: 'HIGH',
    test: (line: string) =>
      /child_process.*exec\s*\(/.test(line) ||
      /\bexecSync\s*\(/.test(line),
  },
];

const IGNORE_PATTERNS = [
  /^node_modules\//,
  /^\.git\//,
  /^dist\//,
  /^coverage\//,
  /^\.worktrees\//,
  /^\.serena\//,
  /^\.terraform\//,
  /\.tfstate/,
  /\.local\.json$/,
];

function isIgnoredFile(filePath: string): boolean {
  return IGNORE_PATTERNS.some((p) => p.test(filePath));
}

/**
 * Scans the added lines of a unified diff for security anti-patterns.
 * It skips `+++` header lines and the files that match `IGNORE_PATTERNS`.
 * Each finding carries the new-file line number from the hunk header, and a context string cut to 120 characters.
 */
export function scanDiffContent(diffContent: string): SecurityFinding[] {
  if (!diffContent.trim()) {
    return [];
  }

  const findings: SecurityFinding[] = [];
  let currentFile = '';
  let diffLineNum = 0;

  for (const line of diffContent.split('\n')) {
    const fileMatch = line.match(/^diff --git a\/(.+) b\//);
    if (fileMatch) {
      currentFile = fileMatch[1] ?? '';
      diffLineNum = 0;
      continue;
    }

    if (isIgnoredFile(currentFile)) {
      continue;
    }

    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      diffLineNum = parseInt(hunkMatch[1] ?? '0', 10);
      continue;
    }

    if (!line.startsWith('+')) {
      if (!line.startsWith('-')) {
        diffLineNum++;
      }
      continue;
    }

    if (line.startsWith('+++')) {
      continue;
    }

    const addedLine = line.slice(1);

    for (const pattern of SECURITY_PATTERNS) {
      if (pattern.test(addedLine)) {
        let context = addedLine.trim();
        if (context.length > 120) {
          context = context.slice(0, 117) + '...';
        }

        findings.push({
          file: currentFile,
          line: diffLineNum,
          pattern: pattern.name,
          severity: pattern.severity,
          context,
        });
      }
    }

    diffLineNum++;
  }

  return findings;
}

function generateReport(findings: readonly SecurityFinding[]): string {
  const lines: string[] = ['## Security Scan Report', ''];

  if (findings.length === 0) {
    lines.push('No security patterns detected.', '', '---', '', '**Result: CLEAN** (0 findings)');
  } else {
    lines.push(`**Findings (${findings.length}):**`, '');
    for (const f of findings) {
      lines.push(`- **${f.severity}** \`${f.file}:${f.line}\` -- ${f.pattern}: \`${f.context}\``);
    }
    lines.push('', '---', '', `**Result: FINDINGS** (${findings.length} security patterns detected)`);
  }

  return lines.join('\n');
}

/**
 * Runs the scan through the shared phase-gate runner, which records durable gate evidence before a success carrier returns.
 * The gate declares that evidence as a postcondition, so a plain event append does not satisfy its contract.
 */
export async function handleSecurityScan(
  args: SecurityScanArgs,
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  if (args.diffContent === undefined || args.diffContent === null) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'diffContent is required' },
    };
  }

  const diffContent = args.diffContent;
  const featureId = args.featureId;
  const diffDigest = createHash('sha256').update(diffContent, 'utf8').digest('hex');
  return runPhaseGateWithEvidence({
    streamId: featureId,
    gateClass: 'security-scan',
    requirementId: 'requirement:security-scan',
    stateDir,
    eventStore,
    subject: (phaseAttemptId) =>
      createEvidenceSubject(
        { kind: 'phase-attempt', phaseAttemptId },
        { gate: 'security-scan', diffDigest },
      ),
    providerInput: args,
    executeProvider: async () => executeSecurityScan(featureId, diffContent, eventStore),
  });
}

async function executeSecurityScan(
  featureId: string,
  diffContent: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  const findings = scanDiffContent(diffContent);
  const passed = findings.length === 0;
  const report = generateReport(findings);

  const result: SecurityScanResult = {
    passed,
    findingCount: findings.length,
    findings,
    report,
  };
  const carrier: ToolResult = { success: true, data: result };

  const store = eventStore;
  const unrecorded = await requireGateEvent(
    store,
    featureId,
    'security-scan',
    'quality',
    passed,
    carrier,
    {
      dimension: 'D1',
      phase: 'review',
      findingCount: findings.length,
    },
    sameOperationGateKey('security-scan'),
  );
  if (unrecorded !== undefined) return unrecorded;

  return carrier;
}
