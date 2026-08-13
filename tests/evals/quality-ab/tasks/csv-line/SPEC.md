# Task: csvParseLine

**Risk Tier:** high · **Boundary Touching:** true
**Test Layer:** unit

Implement `csvParseLine` in `impl.ts`, exporting exactly:

```ts
/** Parse ONE CSV record (a single line) into its fields (RFC 4180 style). */
export function csvParseLine(line: string): string[];
```

## Rules

- Fields are separated by commas (`,`).
- A field is **quoted** if and only if its first character is a double quote (`"`).
  - A quoted field ends at the next unescaped double quote.
  - Inside a quoted field, a literal double quote is written as two double quotes
    (`""`) and unescapes to a single `"`.
  - A quoted field may contain commas — they are part of the value, not
    separators.
  - The surrounding quotes are removed from the returned value.
  - After a quoted field's closing quote, the next character must be either a
    comma or the end of the line. Anything else is malformed.
- An **unquoted** field is taken literally, including any whitespace and any
  double quotes that are not at the start (`a"b` is the literal 3-char field
  `a"b`).
- Empty fields are allowed: `"a,,b"` → `["a", "", "b"]`.
- A trailing comma yields a trailing empty field: `"a,"` → `["a", ""]`.
- The empty string yields a single empty field: `""` → `[""]`.

## Errors — throw an `Error` for malformed input

- an unterminated quoted field (`"abc`)
- junk between a quoted field's closing quote and the next comma/end (`"a"b`)

## Examples

- `csvParseLine("a,b,c")` → `["a", "b", "c"]`
- `csvParseLine("a,,c")` → `["a", "", "c"]`
- `csvParseLine('"a,b",c')` → `["a,b", "c"]`
- `csvParseLine('"a""b"')` → `['a"b']`
- `csvParseLine('a"b')` → `['a"b']`
- `csvParseLine('"hi",,"x,y"')` → `["hi", "", "x,y"]`

This is a high-risk parsing contract — cover the quoting/escaping edge cases and
make sure your tests can actually fail.
