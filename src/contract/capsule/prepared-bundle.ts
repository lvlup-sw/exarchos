/** Structural prepared-bundle codec. Semantic record validation belongs to the record reader. */
import { WorkflowDefinitionV1Schema, type WorkflowDefinitionV1 } from '@lvlup-sw/strategos-contracts';
import { z } from 'zod';
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

/** Encode through the schema first, so a document no reader recognises never reaches custody. */
export function encodePreparedBundle(bundle: PreparedBundleV1): Uint8Array {
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
  return { capsule: parsed.capsule, definition: WorkflowDefinitionV1Schema.parse(parsed.definition),
    ...(parsed.designRecord !== undefined ? { designRecord: parsed.designRecord } : {}),
  };
}
