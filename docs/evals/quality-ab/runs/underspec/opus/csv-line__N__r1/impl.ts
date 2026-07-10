/** Parse ONE CSV record (a single line) into its fields (RFC 4180 style). */
export function csvParseLine(line: string): string[] {
  const fields: string[] = [];
  const length = line.length;
  let index = 0;

  // Each iteration consumes exactly one field (plus its trailing comma, if any).
  // The loop always runs at least once, so an empty input yields a single empty
  // field (`[""]`), matching the "one empty field per empty record" convention.
  for (;;) {
    let value = '';

    if (index < length && line[index] === '"') {
      // Quoted field: consume the opening quote, then read until the closing
      // (unescaped) quote. A doubled quote (`""`) is an escaped literal `"`.
      index += 1;

      while (index < length) {
        const char = line[index];

        if (char === '"') {
          if (index + 1 < length && line[index + 1] === '"') {
            value += '"';
            index += 2;
          } else {
            // Closing quote: consume it and stop reading the quoted body.
            index += 1;
            break;
          }
        } else {
          value += char;
          index += 1;
        }
      }

      // Lenient handling of any characters between the closing quote and the
      // next comma (or end of line): append them literally rather than dropping
      // data. (Well-formed RFC 4180 input has none.)
      while (index < length && line[index] !== ',') {
        value += line[index];
        index += 1;
      }
    } else {
      // Unquoted field: taken literally up to the next comma (or end of line),
      // including whitespace and any interior double quotes.
      while (index < length && line[index] !== ',') {
        value += line[index];
        index += 1;
      }
    }

    fields.push(value);

    if (index < length && line[index] === ',') {
      // Consume the separator and continue with the next field.
      index += 1;
    } else {
      break;
    }
  }

  return fields;
}
