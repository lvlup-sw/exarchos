// ─── Agent Spec Action Handler ─────────────────────────────────────────────
//
// Handles the `agent_spec` action: looks up an agent specification by ID,
// interpolates template variables, and returns the spec in the requested format.
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import type { ToolResult } from '../format.js';
import { ALL_AGENT_SPECS } from './definitions.js';
import type { AgentSpec } from './types.js';

// ─── Schema ─────────────────────────────────────────────────────────────────

const AGENT_IDS = ALL_AGENT_SPECS.map(s => s.id) as [string, ...string[]];

export const agentSpecSchema = z.object({
  agent: z.enum(AGENT_IDS),
  context: z.record(z.string(), z.string()).optional(),
  outputFormat: z.enum(['full', 'prompt-only']).default('full'),
});

type AgentSpecArgs = z.infer<typeof agentSpecSchema>;

// ─── Template Interpolation ─────────────────────────────────────────────────

const TEMPLATE_VAR_PATTERN = /\{\{(\w+)\}\}/g;

function interpolatePrompt(
  prompt: string,
  context: Record<string, string>,
): { systemPrompt: string; unresolvedVars: string[] } {
  let systemPrompt = prompt;

  // Replace all provided context vars
  for (const [key, value] of Object.entries(context)) {
    systemPrompt = systemPrompt.replaceAll(`{{${key}}}`, value);
  }

  // Detect unresolved vars
  const unresolvedVars: string[] = [];
  let match: RegExpExecArray | null;
  const regex = new RegExp(TEMPLATE_VAR_PATTERN.source, 'g');
  while ((match = regex.exec(systemPrompt)) !== null) {
    if (!unresolvedVars.includes(match[1])) {
      unresolvedVars.push(match[1]);
    }
  }

  return { systemPrompt, unresolvedVars };
}

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handleAgentSpec(args: AgentSpecArgs): Promise<ToolResult> {
  const { agent, context = {}, outputFormat = 'full' } = args;

  // Find spec by agent ID
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

  // Interpolate template vars
  const { systemPrompt, unresolvedVars } = interpolatePrompt(spec.systemPrompt, context);

  // Format: prompt-only
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

  // Format: full
  return {
    success: true,
    data: {
      agent: spec.id,
      systemPrompt,
      tools: [...spec.tools],
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
