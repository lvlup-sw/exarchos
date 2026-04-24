/**
 * T043 (DR-5) — `/exarchos:rehydrate` slash command must invoke the
 * first-class `exarchos_workflow.rehydrate` MCP action (registered in T033)
 * rather than the legacy CLI/pipeline-based flow.
 *
 * Prior legacy invocation:
 *   1. `exarchos_view pipeline` to discover active workflows
 *   2. `exarchos_workflow get featureId="<id>" fields=[...]` to fetch playbook
 *
 * New canonical invocation: `exarchos_workflow` tool with
 * `action: "rehydrate"` + `featureId: <arg>` — returns an envelope
 * containing the rehydration document (workflowState, taskProgress,
 * artifacts, blockers, etc.) in a single call.
 *
 * Scope: content-only validation of the command template markdown. No
 * runtime execution required — the command file is consumed by Claude Code
 * as a prompt, not parsed by our TS code.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const commandPath = join(repoRoot, 'commands', 'rehydrate.md');

describe('RehydrateCommand_InvocationReturnsDocument (T043, DR-5)', () => {
  const body = readFileSync(commandPath, 'utf-8');

  it('references the exarchos_workflow MCP tool', () => {
    expect(body).toContain('exarchos_workflow');
  });

  it('references the "rehydrate" action on exarchos_workflow', () => {
    // Accept either the structured MCP form (`action: "rehydrate"` /
    // `action="rehydrate"`) or the bare `exarchos_workflow rehydrate`
    // composite form — both map to handleRehydrate in composite.ts.
    const mentionsRehydrateAction =
      /exarchos_workflow[\s\S]{0,200}\brehydrate\b/.test(body) ||
      /\baction\s*[:=]\s*["']rehydrate["']/.test(body);
    expect(mentionsRehydrateAction).toBe(true);
  });

  it('passes featureId to the rehydrate action', () => {
    expect(body).toMatch(/featureId/);
  });

  it('does NOT invoke the legacy `exarchos_workflow get` fields-array flow', () => {
    // The legacy flow called `exarchos_workflow get` with a `fields` array
    // to assemble the rehydration document client-side. T043 collapses that
    // into a single `rehydrate` action call — so the template must no
    // longer steer the agent toward the legacy multi-call composition.
    expect(body).not.toMatch(/exarchos_workflow\s+get[\s\S]{0,100}fields\s*=\s*\[/);
    expect(body).not.toMatch(/fields\s*=\s*\[\s*["']playbook["']/);
  });

  it('does NOT rely on `exarchos_view pipeline` as the primary discovery step', () => {
    // Legacy step 1 was: `exarchos_view pipeline` then ask user which
    // workflow to rehydrate. The `rehydrate` action now takes featureId
    // directly; discovery (if needed) is a fallback, not the canonical
    // primary step — the command body must not frame pipeline-discovery
    // as the canonical first call.
    expect(body).not.toMatch(/1\.\s*Discover\s+active\s+workflow\(s\)\s+via\s+MCP:\s*`exarchos_view\s+pipeline`/i);
  });
});
