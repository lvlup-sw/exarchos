/** Frozen S7 request semantics survive removal of the live synthesis compiler and handlers. */
import { z } from 'zod';
import { executeRequestDigest } from './run-bundle.js';

/** Original v1 has four required strings and rejects unknown keys. It neither trims nor supplies defaults. */
const HistoricalSynthesisArgs = z.object({
  title: z.string().min(1), prBody: z.string().min(1),
  baseBranch: z.string().min(1), headBranch: z.string().min(1),
}).strict();

/** Only this known historical request recipe can authenticate a run that omitted its input. */
export function historicalSynthesisDigest(streamId: string, args: Record<string, unknown>): string {
  return executeRequestDigest('synthesis-closeout', streamId, HistoricalSynthesisArgs.parse(args));
}
