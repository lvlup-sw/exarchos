/**
 * Public artifact-store surface.
 *
 * This barrel is the packaged entry point for the content-addressed artifact
 * store: consumers import the store, its typed errors, and the path-containment
 * primitives from here rather than reaching into individual modules. The
 * packaged-containment proof (`index.test.ts`) exercises the store's digest,
 * traversal, atomic-publish, and concurrency guarantees *through this surface*
 * to show the shipped entry point behaves identically to the in-source module.
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
