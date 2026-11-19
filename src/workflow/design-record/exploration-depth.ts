/** Syntax checks for the exploration section of a deep design record. */

/** The exact h3 header the deep-depth template requires. */
const EXPLORATION_HEADER = /^###\s+Exploration\b/i;

/**
 * A path-like citation with at least one slash and a file extension. It matches a bare path,
 * a backticked path, or a markdown link target, for example `[report](docs/research/foo.md)`.
 */
const PATH_CITATION = /[\w.-]+\/[\w./-]*\.[a-z0-9]+/i;

/** A `correlationId` citation: the `correlationId` word, or a `discover-bridge:<featureId>` value. */
const CORRELATION_ID_CITATION = /correlation[\s_-]?id|discover-bridge:/i;

/**
 * Returns the lines under the `### Exploration` header, up to the next h1, h2, or h3 heading.
 * An h4 subsection stays in the body. Returns `null` when the header is absent.
 */
export function extractExplorationSection(markdown: string): string | null {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => EXPLORATION_HEADER.test(line));
  if (start === -1) return null;

  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const bodyLine = lines[i] ?? '';
    if (/^#{1,3}\s+/.test(bodyLine)) break;
    body.push(bodyLine);
  }
  return body.join('\n');
}

/** Verdict from {@link checkExplorationDepth}. */
export interface ExplorationCheckResult {
  readonly passed: boolean;
  readonly hasSection: boolean;
  readonly citesPath: boolean;
  readonly citesCorrelationId: boolean;
  readonly reason: string;
}

/**
 * Pure check of a `deep` spec. It fails when the `### Exploration` section is absent, or when
 * the section does not cite both a report path and a `correlationId`.
 */
export function checkExplorationDepth(markdown: string): ExplorationCheckResult {
  const section = extractExplorationSection(markdown);
  if (section === null) {
    return {
      passed: false,
      hasSection: false,
      citesPath: false,
      citesCorrelationId: false,
      reason:
        "deep-depth spec is missing the required '### Exploration' section " +
        '(deep specs must cite the /exarchos:discover research pass by path + correlationId).',
    };
  }

  const citesPath = PATH_CITATION.test(section);
  const citesCorrelationId = CORRELATION_ID_CITATION.test(section);
  const passed = citesPath && citesCorrelationId;

  let reason: string;
  if (passed) {
    reason = "'### Exploration' section cites the /exarchos:discover pass by path + correlationId.";
  } else {
    const missing: string[] = [];
    if (!citesPath) missing.push('a /exarchos:discover report path');
    if (!citesCorrelationId) missing.push('a correlationId');
    reason =
      "'### Exploration' section is present but does not cite " +
      `${missing.join(' and ')} (deep specs must stitch the discover pass by path + correlationId).`;
  }

  return { passed, hasSection: true, citesPath, citesCorrelationId, reason };
}
