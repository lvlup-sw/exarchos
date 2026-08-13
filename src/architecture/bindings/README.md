# The composition root

Every census in this package is pure with respect to the tree it governs: it
takes the tables, schemas and directories it needs as parameters rather than
importing them from the subject. These modules are where that inversion is
discharged — they import the real values from the subject and hand them to the
censuses.

Keeping the edge here rather than deleting it is deliberate. Re-typing the
subject's constants inside this package would remove the import and pass a naive
boundary check while quietly reintroducing the drift the constants exist to
prevent: the census would keep asserting against a copy that no longer matches
what ships. One honest edge at a named seam beats a dozen silent duplicates.

The boundary rule is therefore "no *uninverted* edge into the subject", and this
directory is its sole exception.

## Why one module per subject

The split is not cosmetic. DR-1's declaration seam forbids a single module from
both consuming declarations (importing `contract/declaration.ts`) and reading a
declaration store (`registry.ts`, `events/schemas.ts`) — a module that does both
pins the declaration site in place and blocks the #1258 relocation.

A single flat `bindings.ts` tripped exactly that rule, and rightly so. Splitting
per subject satisfies DR-1 structurally rather than by exemption: no binding
module imports both sides, so none of them needs to appear in
`DECLARATION_SEAM.sourceAdapters`.

**When adding a binding, keep it in its subject's own module.** A new import
that pairs a contract module with a store in one file is a real DR-1 violation,
not a formality — `layer-boundaries-seam` will fail it.
