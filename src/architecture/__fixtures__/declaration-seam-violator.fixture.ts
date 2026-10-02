/**
 * Test fixture, not a shipped consumer. It is the seeded subject for the kill probe of the
 * declaration-seam census.
 *
 * The module imports the declaration envelope and the declaration store `events/schemas.js`.
 * {@link ../layer-boundaries-seam.js} must reject that pair. `layer-boundaries-seam.test.ts`
 * runs the real detector over this file and adds the result to the live scan. The scanner
 * excludes `__fixtures__/`, so this file does not change the live census.
 *
 * A correct consumer takes a `DeclarationSource` through `openDeclarationSeam` and imports no
 * store.
 */

import type { Declaration } from '../../contract/declaration.js';
import { EVENT_EMISSION_REGISTRY } from '../../events/schemas.js';

/** The bypass: lifts an envelope straight out of the store, around the seam. */
export function readEventDeclarationBypassingTheSeam(
  eventType: keyof typeof EVENT_EMISSION_REGISTRY,
): Declaration<'event'> {
  return {
    kind: 'event',
    id: eventType,
    authority: 'registry',
    boundTo: [],
    subject: EVENT_EMISSION_REGISTRY[eventType],
  };
}
