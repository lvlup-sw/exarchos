/** Shared heading-presence policy preserves the legacy handler semantics. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extractSectionsFromTemplateText(content: string): readonly string[] {
  const sections: string[] = [];
  for (const line of content.split('\n')) {
    const match = /^##\s+(.+)$/.exec(line);
    if (match?.[1] !== undefined) {
      sections.push(match[1].trim());
    }
  }
  return sections;
}

export function validateSections(
  body: string,
  requiredSections: readonly string[],
): { passed: boolean; missingSections: readonly string[]; report: string } {
  const missing: string[] = [];
  for (const section of requiredSections) {
    const pattern = new RegExp(`^##\\s+${escapeRegExp(section)}\\s*$`, 'im');
    if (!pattern.test(body)) {
      missing.push(section);
    }
  }

  const reportLines: string[] = [];
  if (missing.length > 0) {
    reportLines.push('PR body validation failed.');
    for (const section of missing) {
      reportLines.push(`  Missing: ## ${section}`);
    }
    reportLines.push('');
    reportLines.push(`Required sections: ${requiredSections.join(', ')}`);
  } else {
    reportLines.push('PR body validation passed.');
  }

  return {
    passed: missing.length === 0,
    missingSections: missing,
    report: reportLines.join('\n'),
  };
}
