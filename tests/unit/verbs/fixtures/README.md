# `prepare_review` provisioning fixtures

## `prepare-review-pre-dr25.json`

The **pre-DR-25 kill fixture**: the verbatim `handlePrepareReview({ scope: 'plan', … })`
result as it was emitted on the commit immediately BEFORE task 046 bound the dispatch
shape to the declared posture.

It carries `data.posture === 'read-only'` and **no `data.dispatch` field** — the exact
output that produced the 2026-08-07 phantom-teammate incident (provisioned `read-only`,
dispatched `name`-without-`isolation`, three idle mailbox teammates, zero verdicts).

Captured here because task 046 removes that output from the codebase. Without a frozen
copy, DR-25's totality guard would have no currently-failing subject, and *"a guard with
no current failing subject has not been shown to work."*

**Consumer:** task 047 (`__tests__/dispatch-shape.kill-fixture.test.ts`) asserts this
fixture fails the dispatch totality/consistency validation on introduction.

Do not regenerate this file. It is a historical artifact, not a golden snapshot — a
regenerated copy would carry the post-DR-25 `dispatch` field and silently defeat the kill
test.
