/**
 * The `agent_spec` action handler. It finds an agent specification by ID, fills its template variables, and returns it in the requested format.
 */

import { z } from 'zod';
import type { ToolResult } from '../../format.js';
import { ALL_AGENT_SPECS } from './definitions.js';
import type { AgentSpec } from './types.js';
import { deriveClaudeToolsFromCapabilities } from './adapters/claude.js';

const AGENT_IDS = ALL_AGENT_SPECS.map(s => s.id) as [string, ...string[]];

export const agentSpecSchema = z.object({
  agent: z.enum(AGENT_IDS),
  context: z.record(z.string(), z.string()).optional(),
  outputFormat: z.enum(['full', 'prompt-only']).default('full'),
});

type AgentSpecArgs = z.infer<typeof agentSpecSchema>;

const TEMPLATE_VAR_PATTERN = /\{\{(\w+)\}\}/g;

/** Replace each `{{key}}` in `prompt` with its value from `context`, and list each placeholder that stays unresolved. */
function interpolatePrompt(
  prompt: string,
  context: Record<string, string>,
): { systemPrompt: string; unresolvedVars: string[] } {
  let systemPrompt = prompt;

  for (const [key, value] of Object.entries(context)) {
    systemPrompt = systemPrompt.replaceAll(`{{${key}}}`, value);
  }

  const unresolvedVars: string[] = [];
  let match: RegExpExecArray | null;
  const regex = new RegExp(TEMPLATE_VAR_PATTERN.source, 'g');
  while ((match = regex.exec(systemPrompt)) !== null) {
    const varName = match[1];
    if (varName !== undefined && !unresolvedVars.includes(varName)) {
      unresolvedVars.push(varName);
    }
  }

  return { systemPrompt, unresolvedVars };
}

/**
 * Return the spec of one agent with its template variables filled.
 * The `full` format derives the Claude `tools` array from the capability declarations, through the Claude adapter.
 */
export async function handleAgentSpec(args: AgentSpecArgs): Promise<ToolResult> {
  const { agent, context = {}, outputFormat = 'full' } = args;

  const spec: AgentSpec | undefined = ALL_AGENT_SPECS.find(s => s.id === agent);

  if (!spec) {
    return {
      success: false,
      error: {
        code: 'UNKNOWN_AGENT',
        message: `Unknown agent '${agent}'. Valid agents: ${AGENT_IDS.join(', ')}`,
        validTargets: AGENT_IDS,
      },
    };
  }

  const { systemPrompt, unresolvedVars } = interpolatePrompt(spec.systemPrompt, context);

  if (outputFormat === 'prompt-only') {
    return {
      success: true,
      data: {
        agent: spec.id,
        systemPrompt,
        unresolvedVars,
      },
    };
  }

  return {
    success: true,
    data: {
      agent: spec.id,
      systemPrompt,
      tools: [...deriveClaudeToolsFromCapabilities(spec)],
      disallowedTools: spec.disallowedTools ? [...spec.disallowedTools] : undefined,
      model: spec.model,
      isolation: spec.isolation,
      validationRules: [...spec.validationRules],
      resumable: spec.resumable,
      memoryScope: spec.memoryScope,
      maxTurns: spec.maxTurns,
      mcpServers: spec.mcpServers ? [...spec.mcpServers] : undefined,
      skills: spec.skills.map(s => ({ name: s.name, content: '' })),
      unresolvedVars,
    },
  };
}
