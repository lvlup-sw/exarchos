# `docs/` — what is written down

Specs, guides, architecture notes, ADRs and RCAs. Prose about the system, kept
next to the system.

Start at [`ARCHITECTURE.md`](ARCHITECTURE.md): it states the directory
contract, how the tree maps onto the published layer architecture, the one-way
import rule, and how authored content relates to the generated trees.

## The subdirectories that carry weight

- `architecture/` — how the system is built, including the invariant reference
  notes the catalog cites.
- `specs/` — the unified design-and-decomposition documents workflows produce.
  One document per feature: rationale and task breakdown in the same file.
- `guides/` — operational how-to. `ci-gate-hosting.md` and
  `toolchain-resolution.md` are the two most often needed.
- `rca/` — incident write-ups. Read one before re-deriving a failure someone
  has already paid for.
- `adrs/` — decisions with their alternatives, kept because the alternatives
  are the part that gets forgotten.

## What does not belong here

- Anything a program reads to decide behavior. Configuration lives with the
  code that consumes it, and the dev catalog lives in `.exarchos/`. A document
  that a gate parses stops being documentation and becomes an undeclared
  input.
- Content that instructs an agent — that is `content/`, and it is rendered.

## A caution about citing this tree

Paths under `specs/`, `designs/` and `plans/` are not stable: documents are
revised, renumbered and moved out. Source comments must not cite them — the
comment policy in `.exarchos/comment-policy.json` rejects it, on the grounds
that a citation accurate when written stops being so without anything
changing. State the constraint in words instead, and cite the durable record.
