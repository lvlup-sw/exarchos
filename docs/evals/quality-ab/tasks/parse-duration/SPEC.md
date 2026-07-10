# Task: parseDuration

**Risk Tier:** medium
**Test Layer:** unit

Implement `parseDuration` in `impl.ts`, exporting exactly:

```ts
/** Parse a human duration string into a total number of milliseconds. */
export function parseDuration(input: string): number;
```

## Grammar & semantics

- The input is a concatenation of one or more `<amount><unit>` segments, e.g.
  `"1h30m"`, `"500ms"`, `"2d"`, `"1h30m15s"`, `"90m"`.
- `<amount>` is a non-negative integer (one or more digits).
- `<unit>` is one of: `ms` (milliseconds), `s` (seconds), `m` (minutes),
  `h` (hours), `d` (days). Units are lowercase.
- Unit values: `1s = 1000ms`, `1m = 60s`, `1h = 60m`, `1d = 24h`.
- Whitespace anywhere in the input is ignored (`"1h 30m"` === `"1h30m"`).
- The result is the sum of all segments in milliseconds.

## Errors — throw an `Error` for any invalid input

- empty string (or only whitespace)
- a number with no unit (`"10"`)
- an unrecognized unit (`"10x"`)
- any characters that are not part of a valid `<amount><unit>` sequence

## Examples

- `parseDuration("500ms")` → `500`
- `parseDuration("1s")` → `1000`
- `parseDuration("5m")` → `300000`
- `parseDuration("1h")` → `3600000`
- `parseDuration("1d")` → `86400000`
- `parseDuration("1h30m")` → `5400000`
- `parseDuration("1h30m15s")` → `5415000`

Note the `ms` / `m` distinction: `"500ms"` is 500 milliseconds, not 500 minutes.
This is a medium-risk task — cover the behavior with tests judged by outcome.
