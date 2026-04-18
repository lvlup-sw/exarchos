// ─── VCS Action: create_issue ───────────────────────────────────────────────
//
// Creates an issue via the VCS provider abstraction.
// Emits an `issue.created` event on success.

import type { DispatchContext } from '../../core/dispatch.js';
import type { ToolResult } from '../../format.js';
import { createVcsProvider } from '../../vcs/factory.js';

export interface HandleCreateIssueArgs {
  readonly title: string;
  readonly body: string;
  readonly labels?: string[];
}

export async function handleCreateIssue(
  args: HandleCreateIssueArgs,
  ctx: DispatchContext,
): Promise<ToolResult> {
  const provider = await createVcsProvider({ config: ctx.projectConfig });

  let result;
  try {
    result = await provider.createIssue({
      title: args.title,
      body: args.body,
      labels: args.labels,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: { code: 'VCS_ERROR', message: `create_issue failed: ${message}` },
    };
  }

  try {
    await ctx.eventStore.append('vcs', {
      type: 'issue.created',
      data: {
        provider: provider.name,
        issueNumber: result.number,
        url: result.url,
      },
    });
  } catch {
    // Event emission is best-effort — issue already created
  }

  return { success: true, data: result };
}
