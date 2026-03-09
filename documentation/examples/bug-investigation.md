---
outline: deep
---

# Bug Investigation

This example walks through investigating and fixing a timezone bug using the debug workflow's thorough track.

## The bug

Users report that scheduled events fire at the wrong time. A user in New York schedules a notification for 9:00 AM Eastern, but it fires at 9:00 AM UTC instead. The bug only affects users outside the UTC timezone.

## Triage

Start the debug workflow:

```bash
/exarchos:debug Scheduled events fire at wrong time for users in non-UTC timezones
```

Exarchos enters triage and collects information. What error messages appear? None, the events fire successfully but at the wrong time. How many users are affected? Anyone outside UTC. Is there a workaround? No. When did this start? After the scheduler was added two weeks ago.

Triage classifies this as a logic bug, moderate severity, root cause unknown. The thorough track is selected because the cause is not immediately obvious and the fix scope is unclear.

## Investigation

Investigation follows a systematic approach.

Reproduce: Create a scheduled event with timezone `America/New_York` set for 2:00 PM. The event fires at 2:00 PM UTC (which is 9:00 AM Eastern), five hours early. Bug confirmed.

Narrow down the call path from event creation to scheduling:

1. `createEvent()` receives the event time and timezone from the user
2. `schedulerService.scheduleEvent()` converts the time to UTC for internal storage
3. The conversion at line 47 of `schedulerService.ts` uses `new Date(eventTime)` without passing the timezone

There it is. `new Date()` parses the string in the server's local timezone (UTC in production), not the user's configured timezone. The offset is never applied.

Verify the hypothesis: set the server timezone to `America/New_York` and create the same event. It now fires at the correct time locally, but would be wrong for a user in `Europe/London`. The root cause is confirmed: timezone-naive date parsing.

## Root cause analysis

Exarchos documents the findings:

```text
RCA saved to docs/rca/2026-03-08-scheduler-timezone.md

  Symptom: Scheduled events fire at server timezone instead of user timezone
  Root cause: schedulerService.ts line 47 uses new Date(eventTime) which
    parses in the server's local timezone, ignoring the event's configured timezone
  Affected paths:
    - All scheduled event creation
    - Recurring event generation (uses the same parsing)
  Fix approach: Replace naive Date parsing with timezone-aware parsing using
    the event's timezone field
```

No design change is needed. The scheduler already stores the user's timezone; it just does not use it during parsing.

## Fix

An implementer agent works in a worktree following TDD.

RED. Write a test in `scheduler.test.ts`:

```typescript
it('should schedule event at correct time for America/New_York timezone', () => {
  const event = createEvent({
    time: '2026-03-08T14:00:00',
    timezone: 'America/New_York'
  });
  const scheduled = schedulerService.scheduleEvent(event);
  // 2:00 PM Eastern = 7:00 PM UTC (EST is UTC-5)
  expect(scheduled.utcTime).toBe('2026-03-08T19:00:00.000Z');
});
```

Test fails. The actual value is `2026-03-08T14:00:00.000Z` because the timezone offset is not applied.

GREEN. Replace the naive parsing:

```typescript
// Before:
const utcTime = new Date(eventTime);

// After: construct a Date in UTC, then adjust by the timezone offset
// Temporal.ZonedDateTime (or a library like date-fns-tz) handles this correctly:
const zonedTime = Temporal.PlainDateTime.from(eventTime)
  .toZonedDateTime(event.timezone);
const utcTime = new Date(zonedTime.epochMilliseconds);
```

Test passes.

Additional test: add a test for DST transitions. An event scheduled on March 9 (when clocks spring forward) should use UTC-4, not UTC-5:

```typescript
it('should handle DST transition for America/New_York', () => {
  const event = createEvent({
    time: '2026-03-09T14:00:00',
    timezone: 'America/New_York'
  });
  const scheduled = schedulerService.scheduleEvent(event);
  // After spring forward: 2:00 PM EDT = 6:00 PM UTC (EDT is UTC-4)
  expect(scheduled.utcTime).toBe('2026-03-09T18:00:00.000Z');
});
```

Passes. The timezone-aware parsing handles DST correctly.

## Validation

Convergence gates run against the fix branch:

- All scheduler tests pass (including the two new ones)
- Static analysis clean
- No regressions in related test suites

Spec review confirms the fix matches the root cause from the RCA, tests cover both the base case and the DST edge case, and no unrelated changes are included.

Verdict: **APPROVED**.

## Ship

Synthesis creates a PR:

```text
PR #87: fix: use timezone-aware parsing for scheduled events

  Summary: Scheduled events were firing at server timezone instead of the
  user's configured timezone. The scheduler now applies the event's timezone
  during date parsing, correctly handling DST transitions.

  RCA: docs/rca/2026-03-08-scheduler-timezone.md
  Tests: 24 pass · Build 0 errors
```

CI passes. You merge and run `/exarchos:cleanup`. The RCA document stays in the repository for future reference.
