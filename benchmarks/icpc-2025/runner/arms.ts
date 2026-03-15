import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArmConfig, ArmId, ProblemDefinition } from './types.js';

/**
 * Parse simple YAML frontmatter from markdown content.
 * Handles only simple key: value pairs (no nesting, no arrays).
 */
function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { meta: {}, body: content };
  }

  const meta: Record<string, string> = {};
  const lines = match[1].split('\n');
  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    meta[key] = value;
  }

  return { meta, body: match[2] };
}

/**
 * Load an arm configuration from its markdown file.
 */
export function loadArm(armDir: string, armId: ArmId): ArmConfig {
  const filePath = join(armDir, `${armId}.md`);
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    throw new Error(`Arm definition not found: ${filePath}`);
  }

  const { meta, body } = parseFrontmatter(content);

  return {
    id: armId,
    name: meta['name'] ?? armId,
    description: meta['description'] ?? '',
    promptTemplate: body.trim(),
    mcpEnabled: meta['mcpEnabled'] === 'true',
  };
}

/**
 * Build a complete prompt by interpolating problem data into an arm's template.
 */
export function buildPrompt(problem: ProblemDefinition, arm: ArmConfig, language: string): string {
  const samplesText = problem.samples
    .map((s) => `### Sample ${s.id}\n**Input:**\n\`\`\`\n${s.input}\n\`\`\`\n**Output:**\n\`\`\`\n${s.output}\n\`\`\``)
    .join('\n\n');

  return arm.promptTemplate
    .replace(/\{\{PROBLEM_STATEMENT\}\}/g, problem.statement)
    .replace(/\{\{SAMPLES\}\}/g, samplesText)
    .replace(/\{\{LANGUAGE\}\}/g, language);
}
