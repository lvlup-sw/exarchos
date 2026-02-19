import type { PRDiffMetadata, PRRiskScore, RiskFactor } from './types.js';

const SECURITY_PATH_PATTERN = /auth|security|crypto|token|secret|credential|permission/i;
const API_SURFACE_PATTERN = /api\/|controller|endpoint|middleware|handler/i;
const INFRA_CONFIG_PATTERN = /dockerfile|\.ya?ml$|\.env|infra\/|deploy|ci\//i;

interface FactorDefinition {
  name: string;
  weight: number;
  evaluate: (pr: PRDiffMetadata) => { matched: boolean; detail: string };
}

const FACTOR_DEFINITIONS: FactorDefinition[] = [
  {
    name: 'security-path',
    weight: 0.30,
    evaluate: (pr) => {
      const matchedPaths = pr.paths.filter(p => SECURITY_PATH_PATTERN.test(p));
      return {
        matched: matchedPaths.length > 0,
        detail: matchedPaths.length > 0
          ? `Matched security paths: ${matchedPaths.join(', ')}`
          : 'No security-sensitive paths',
      };
    },
  },
  {
    name: 'api-surface',
    weight: 0.20,
    evaluate: (pr) => {
      const matchedPaths = pr.paths.filter(p => API_SURFACE_PATTERN.test(p));
      return {
        matched: matchedPaths.length > 0,
        detail: matchedPaths.length > 0
          ? `Matched API paths: ${matchedPaths.join(', ')}`
          : 'No API surface paths',
      };
    },
  },
  {
    name: 'diff-complexity',
    weight: 0.15,
    evaluate: (pr) => {
      const largeLines = pr.linesChanged > 300;
      const manyFiles = pr.filesChanged > 10;
      const matched = largeLines || manyFiles;
      return {
        matched,
        detail: matched
          ? `Lines: ${pr.linesChanged}, files: ${pr.filesChanged}`
          : `Within complexity limits (${pr.linesChanged} lines, ${pr.filesChanged} files)`,
      };
    },
  },
  {
    name: 'new-files',
    weight: 0.10,
    evaluate: (pr) => ({
      matched: pr.newFiles > 0,
      detail: pr.newFiles > 0
        ? `${pr.newFiles} new file(s) introduced`
        : 'No new files',
    }),
  },
  {
    name: 'infra-config',
    weight: 0.15,
    evaluate: (pr) => {
      const matchedPaths = pr.paths.filter(p => INFRA_CONFIG_PATTERN.test(p));
      return {
        matched: matchedPaths.length > 0,
        detail: matchedPaths.length > 0
          ? `Matched infra/config paths: ${matchedPaths.join(', ')}`
          : 'No infrastructure paths',
      };
    },
  },
  {
    name: 'cross-module',
    weight: 0.10,
    evaluate: (pr) => {
      const topLevelDirs = new Set(
        pr.paths.map(p => p.split('/')[0])
      );
      const matched = topLevelDirs.size > 2;
      return {
        matched,
        detail: matched
          ? `Spans ${topLevelDirs.size} top-level directories: ${[...topLevelDirs].join(', ')}`
          : `${topLevelDirs.size} top-level director${topLevelDirs.size === 1 ? 'y' : 'ies'}`,
      };
    },
  },
];

export function scorePR(pr: PRDiffMetadata): PRRiskScore {
  const factors: RiskFactor[] = FACTOR_DEFINITIONS.map(def => {
    const { matched, detail } = def.evaluate(pr);
    return {
      name: def.name,
      weight: def.weight,
      matched,
      detail,
    };
  });

  const score = factors
    .filter(f => f.matched)
    .reduce((sum, f) => sum + f.weight, 0);

  const recommendation = score >= 0.4 ? 'coderabbit' : 'self-hosted';

  return {
    pr: pr.number,
    score,
    factors,
    recommendation,
  };
}
