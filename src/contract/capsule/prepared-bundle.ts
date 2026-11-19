/** Structural prepared-bundle codec. Semantic record validation belongs to the record reader. */
import { WorkflowDefinitionV1Schema, type WorkflowDefinitionV1 } from '@lvlup-sw/strategos-contracts';
import { z } from 'zod';
import { readDesignRecord } from '../../workflow/design-record/read.js';
import { checkDefinitionDocument } from '../../workflow/definitions/extension.js';
import { classifyStep } from '../../workflow/definitions/step-locator.js';
import { validateDesignRecord } from '../../workflow/design-record/validate.js';
import { resolveCapsuleReferences } from './capsule-references.js';
import { ExarchosCapsuleV1Schema, type ExarchosCapsuleV1 } from './exarchos-capsule.js';
import { canonicalJson } from '../request-context.js';

/** The `kind` discriminator every prepared bundle carries. */
export const PREPARED_BUNDLE_KIND = 'prepared-capsule';

/** The document version. A change that an old reader can misread needs a new version. */
export const PREPARED_BUNDLE_VERSION = '1.0';

export const PreparedBundleV1Schema = z
  .object({
    bundleVersion: z.literal(PREPARED_BUNDLE_VERSION),
    kind: z.literal(PREPARED_BUNDLE_KIND),
    capsule: ExarchosCapsuleV1Schema,
    /** Validated against the published kernel on decode, not trusted as an opaque record. */
    definition: z.record(z.string(), z.unknown()),
    designRecord: z.object({ reference: z.string(), text: z.string() }).strict().optional(),
  })
  .strict();

export interface PreparedBundleV1 {
  readonly capsule: ExarchosCapsuleV1;
  readonly definition: WorkflowDefinitionV1;
  readonly designRecord?: { readonly reference: string; readonly text: string };
}

/** New compiler custody requires the complete semantic contract and its approved source bytes. */
function requireCompilerCustody(bundle: PreparedBundleV1): void {
  if (bundle.capsule.provenance.compilerVersion !== 'exarchos-prepare-8') return;
  const verdict = resolveCapsuleReferences(bundle.capsule, { definition: bundle.definition });
  if (!verdict.ok) throw new Error(`Incomplete compiler-8 custody: ${JSON.stringify(verdict.violations)}`);
  if (bundle.designRecord === undefined) throw new Error('Compiler-8 custody requires the approved design record');
  const definition = checkDefinitionDocument(bundle.definition, () => []);
  if (!definition.ok || bundle.capsule.graph.tasks.some(task => task.stepId === undefined || classifyStep(definition.definition, task.stepId) !== 'task-batch')) {
    throw new Error('Compiler-8 custody requires a located implementation stage');
  }
  const text = bundle.designRecord.text;
  if (Buffer.from(text, 'utf8').toString('utf8') !== text) throw new Error('Invalid UTF-8 source text');
  const read = readDesignRecord(Buffer.from(text, 'utf8'), bundle.designRecord.reference);
  if (read.kind !== 'typed' || !validateDesignRecord(read.snapshot).passed) throw new Error('Invalid compiler-8 approved plan');
  if (canonicalJson(bundle.capsule.graph.tasks.map(task => task.taskId)) !== canonicalJson(read.snapshot.tasks.map(task => task.id))) {
    throw new Error('Compiler-8 graph must retain every approved task in order');
  }
  for (const [index, task] of bundle.capsule.graph.tasks.entries()) {
    const context = task.taskContext;
    const authored = read.snapshot.tasks[index];
    if (context === undefined || authored === undefined || context.source.digest !== read.snapshot.digest
        || context.source.reference !== bundle.designRecord.reference
        || canonicalJson(context.source.span) !== canonicalJson(authored.span)) {
      throw new Error('Compiler-8 context does not reference its stored design bytes');
    }
    const contextKeys: readonly (keyof typeof context & keyof typeof authored)[] =
      ['title', 'instructions', 'files', 'testFiles', 'acceptance', 'riskTier', 'boundaryTouching', 'testLayer', 'blockedBy'];
    for (const key of contextKeys) {
      if (canonicalJson(context[key]) !== canonicalJson(authored[key])) throw new Error(`Compiler-8 context differs from approved ${key}`);
    }
    const knowledge = authored.knowledgeSlice ?? { invariantIds: [], adrRefs: [], symbols: [], files: [] };
    if (canonicalJson(context.knowledgeSlice) !== canonicalJson(knowledge)) throw new Error('Compiler-8 context differs from approved knowledge');
  }
}

/** Encode through the schema first, so a document no reader recognises never reaches custody. */
export function encodePreparedBundle(bundle: PreparedBundleV1): Uint8Array {
  requireCompilerCustody(bundle);
  const validated = PreparedBundleV1Schema.parse({
    bundleVersion: PREPARED_BUNDLE_VERSION,
    kind: PREPARED_BUNDLE_KIND,
    capsule: bundle.capsule,
    definition: bundle.definition,
    ...(bundle.designRecord !== undefined ? { designRecord: bundle.designRecord } : {}),
  });
  return Buffer.from(`${canonicalJson(validated)}\n`, 'utf8');
}

/** Decode bytes recovered from custody. Throws on anything either contract refuses. */
export function decodePreparedBundle(bytes: Uint8Array): PreparedBundleV1 {
  const parsed = PreparedBundleV1Schema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
  const bundle = { capsule: parsed.capsule, definition: WorkflowDefinitionV1Schema.parse(parsed.definition),
    ...(parsed.designRecord !== undefined ? { designRecord: parsed.designRecord } : {}),
  };
  if (bundle.capsule.provenance.compilerVersion === 'exarchos-prepare-8'
      && !Buffer.from(Buffer.from(bytes).toString('utf8'), 'utf8').equals(Buffer.from(bytes))) throw new Error('Invalid UTF-8 custody');
  requireCompilerCustody(bundle);
  return bundle;
}
