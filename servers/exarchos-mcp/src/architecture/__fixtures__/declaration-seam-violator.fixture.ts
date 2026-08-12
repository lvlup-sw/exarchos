/**
 * TEST FIXTURE — NOT a shipped consumer.
 *
 * The SEEDED SUBJECT for DR-1's kill probe: a declaration consumer that bypasses
 * the seam and reads registry storage directly. It imports the declaration
 * envelope (which makes it a consumer) AND `event-store/schemas.js` (which is a
 * declared declaration store), which is exactly the pair
 * {@link ../layer-boundaries-seam.js}'s declaration-seam census must reject.
 *
 * `layer-boundaries-seam.test.ts` reads this file from disk, runs the real
 * detector over its real source text, and plants the result into the LIVE scan —
 * so the probe exercises the shipped scanner rather than a hand-written stand-in.
 *
 * It lives under `__fixtures__/`, which the scanner excludes, so it can never
 * contaminate the live census it exists to falsify.
 *
 * The correct shape is the opposite of this one: take a `DeclarationSource`
 * through `openDeclarationSeam` and import no store at all.
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
