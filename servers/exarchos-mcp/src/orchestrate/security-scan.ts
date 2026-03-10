// ─── Security Scan Composite Action ─────────────────────────────────────────
//
// Pure TypeScript security scanning — scans diff content for common security
// anti-patterns (hardcoded secrets, eval(), SQL injection, XSS vectors).
// No bash script dependency.
// ────────────────────────────────────────────────────────────────────────────

import type { ToolResult } from '../format.js';
import { getOrCreateEventStore } from '../views/tools.js';
import { emitGateEvent } from './gate-utils.js';

// ─── Types ─────────────────────────────────────────────────────────────────

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

// ─── Security Patterns ──────────────────────────────────────────────────────

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
      /child_process.*exec\s*\(/.test(line) || /exec\s*\(\s*[^"'`]/.test(line),
  },
];

// ─── Ignored File Patterns ───────────────────────────────────────────────────

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

// ─── Diff Scanning ──────────────────────────────────────────────────────────

/**
 * Scan unified diff content for security anti-patterns.
 * Only scans added lines (lines starting with +, excluding +++ headers).
 * Returns an array of structured findings.
 */
export function scanDiffContent(diffContent: string): SecurityFinding[] {
  if (!diffContent.trim()) {
    return [];
  }

  const findings: SecurityFinding[] = [];
  let currentFile = '';
  let diffLineNum = 0;

  for (const line of diffContent.split('\n')) {
    // Track current file from diff headers
    const fileMatch = line.match(/^diff --git a\/(.+) b\//);
    if (fileMatch) {
      currentFile = fileMatch[1];
      diffLineNum = 0;
      continue;
    }

    // Skip scanning ignored files
    if (isIgnoredFile(currentFile)) {
      continue;
    }

    // Track line numbers from hunk headers
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      diffLineNum = parseInt(hunkMatch[1], 10);
      continue;
    }

    // Skip non-addition lines
    if (!line.startsWith('+')) {
      // Context lines (not starting with -) increment the line counter
      if (!line.startsWith('-')) {
        diffLineNum++;
      }
      continue;
    }

    // Skip +++ header lines
    if (line.startsWith('+++')) {
      continue;
    }

    // Strip leading + to get the actual added content
    const addedLine = line.slice(1);

    // Check each security pattern
    for (const pattern of SECURITY_PATTERNS) {
      if (pattern.test(addedLine)) {
        // Truncate context to 120 chars
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

// ─── Report Generation ──────────────────────────────────────────────────────

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

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handleSecurityScan(
  args: SecurityScanArgs,
  stateDir: string,
): Promise<ToolResult> {
  // Guard clause: validate required inputs
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

  // Scan the diff content
  const findings = scanDiffContent(args.diffContent);
  const passed = findings.length === 0;
  const report = generateReport(findings);

  // Emit gate.executed event (fire-and-forget: emission failure must not break the gate check)
  try {
    const store = getOrCreateEventStore(stateDir);
    await emitGateEvent(store, args.featureId, 'security-scan', 'quality', passed, {
      dimension: 'D1',
      phase: 'review',
      findingCount: findings.length,
    });
  } catch { /* fire-and-forget */ }

  // Return structured result
  const result: SecurityScanResult = {
    passed,
    findingCount: findings.length,
    findings,
    report,
  };

  return { success: true, data: result };
}
