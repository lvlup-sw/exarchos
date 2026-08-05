# DR-30 meta-test — what it proves, and what it does not

Task T-40. Read this before trusting a green run.

The point of this file is that the meta-test's own claims are bounded. A guard
that implies more rigour than it implements is the same defect class it exists
to catch, one level up.

## 1. Scope is decided by assertion shape, never by the annotation

`shapes.ts::isInScope(source)` reads only the file's **code view** (comments and
string-literal bodies blanked by `source-view.ts`). The `@oracle-sources`
annotation is *never* an input to scope — only to compliance.

This is the whole anti-evasion mechanism. If scope were annotation-driven,
deleting the annotation would delete the obligation.
`SuiteInvariant_DroppingTheAnnotation_DoesNotDropTheObligation` pins it against
a real in-scope file (this meta-test itself): strip every declaration, and the
file is still in scope with an identical shape list, and now reports
`oracle-sources-missing`.

**What this does NOT prove.** Shape matching is regex over a lexed source view,
not an AST walk. A test can assert containment in a form no listed shape
matches and stay out of scope silently. That is a *false negative*, and it is
mitigated only by the shape list being ratcheted and extensible — not
eliminated. The first draft of the catalogue had exactly this hole: it missed
`orchestrate/contract-drift.parity.test.ts`, one of the three Class B instances
DR-30 names by name. The `derived-pair-parity` shape exists because of that
miss.

## 2. "Derived from another authority in the same module graph"

DR-30's hardest clause. What is implemented:

| Authority kind | Derivation decided by |
| --- | --- |
| Resolvable module path (`./x.ts`, `src/y.js`) | **Real transitive static import-graph reachability** (`corpus.ts::reachesModule`), following `import`/`export … from`/`import()`/`require()` specifiers, memoised, bounded at 4000 nodes |
| Opaque label (`compiled-binary-stdio`, `TOOL_REGISTRY`) | **Declared**, via `registry.ts::KNOWN_DERIVATIONS`. Nothing is inferred. |

This is a genuine transitive graph walk, not a same-file heuristic. It is
nonetheless:

- an **over-approximation of dependency**: A importing B does not prove the
  declared *value* was derived from B. Two authorities can share a module and
  still be independent reads.
- an **under-approximation of value derivation**: two modules that never import
  each other can still both read one JSON file, one database, or one process's
  output. The walk cannot see that. Only `KNOWN_DERIVATIONS` can, and only if
  someone writes the pair down.
- **blind to dynamic specifiers**: `await import(someVariable)` is not followed.
- **blind to non-module authorities entirely**: a compiled binary's stdout and
  the source it was built from are the same authority in every meaningful
  sense, and nothing here can tell.

So: `oracle-sources-derived` firing is strong evidence of a single-source
comparison. It **not** firing is weak evidence of two authorities. The
annotation is a declaration reviewed by humans; the checker only catches the
mechanically-visible lies.

## 3. Block extraction

`extractTestBlocks` balances parentheses over the code view from each
`it(`/`test(` token, and widens backwards to absorb an immediately-preceding
`/** … */` docblock. It does not parse; nested `describe` structure is ignored,
and a block whose parens are unbalanced by a syntax error will run to EOF. Good
enough for the two block-scoped rules, and it fails *loud* (over-large block →
more text scanned → more likely to flag) rather than silent.

## 4. `passed === true` on a could-not-run verdict

The rule keys on the **asserted claim**, not on the presence of a could-not-run
carrier:

- inline — `expect(<expr>.passed).toBe(true)` where `<expr>` itself carries a
  could-not-run marker;
- by binding — the asserted root identifier is bound, in the same block, to an
  initializer carrying such a marker.

An earlier draft keyed on "an object literal carrying both `passed: true` and a
could-not-run marker". It flagged exactly two corpus files —
`orchestrate/static-analysis.test.ts` and
`orchestrate/test-adequacy.production-path.test.ts` — both of which *construct*
the defective carrier in order to prove the system refuses it. That draft
punished the tests that already enforce the property. The negative fixture
`FIXTURE_COULD_NOT_RUN_NEGATIVE_FIXTURE` pins the corrected behaviour.

**Limitation.** Could-not-run is recognised from a fixed vocabulary
(`couldNotRun`, `not-run`, `indeterminate`, `unavailable`, …). A codebase that
spells it some other way is invisible to this rule.

## 5. Vacuity

Two independent teeth, because "the scanner matched nothing" is the failure
mode that would make everything else here worthless:

1. **Fixture proof.** Every rule runs against a positive that must fire and a
   negative that must not, in the same run, before its corpus verdict is
   believed (`PART 1` of the test).
2. **Corpus floors.** `SHAPE_RATCHET` pins a minimum number of real corpus
   files each shape must still match; `BLOCKING_CLAIM_CENSUS_FLOOR` pins a
   minimum number of blocking claims for the kill-fixture rule to police; and
   `CORPUS_FLOORS` pins per-root denominators so a scan root cannot be quietly
   emptied.

Break any matcher into matching nothing and tooth 2 goes red even though every
"0 violations" assertion still passes.

## 6. The ratchet, and its cost

`LEGACY_SHAPE_DEBT` is an **exhaustive explicit path list**, not a threshold.
Consequences, stated plainly:

- **New debt fails.** A new in-scope file without an annotation is not on the
  list.
- **The list can only shrink.** `SuiteInvariant_AcceptedGapRegister_CanOnlyShrink`
  fails on any entry that has been fixed, has fallen out of scope, or no longer
  exists. There is no way to park a closed gap.
- **This is a real tax on unrelated work.** Any change that puts a new file in
  scope — including `expect(a).toEqual(b)` between two computed values — will
  redden this suite until the author either declares two authorities or
  registers an owned, expiring gap. That is DR-30 working as specified, and it
  is also friction. Reviewers should expect it.

## 7. What is registered rather than fixed

See `registry.ts::ACCEPTED_GAPS`. Notably, T-40 is forbidden from editing other
tasks' files, so three live findings are registered with owners and expiries
rather than repaired here:

- `merge-idempotency.test.ts` synthesizes a `DispatchContext` object literal
  instead of driving `createPublicRootHarness()` — exactly the shortcut T-36
  predicted would go unnoticed. Found by this detector on its first corpus run.
- DR-4 criterion 2 is not met in shipped code (T-37's finding).
- The `cancel` characterization of the DR-7 gap is *correct and deliberate*; no
  detector flags it, and it is registered so the category is declared rather
  than living only in a `// KNOWN GAP` comment.
