/**
 * Public surface of the content-addressed artifact store: the store, its typed
 * errors, and the path-containment primitives. The packaged-containment proof
 * (`index.test.ts`) tests the store guarantees through this surface.
 */
export {
  ContentAddressedStore,
  ContentAddressedStoreError,
  type ContentAddressedStoreErrorCode,
  type ContentAddressedStoreIo,
} from './content-addressed-store.js';
export {
  ArtifactPathError,
  type ArtifactPathErrorCode,
  assertSafeArtifactKey,
  assertSafeArtifactSegment,
  resolveContainedArtifactPath,
} from './artifact-path.js';
