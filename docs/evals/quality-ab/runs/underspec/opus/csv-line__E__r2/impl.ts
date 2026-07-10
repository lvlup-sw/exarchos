/** Parse ONE CSV record (a single line) into its fields (RFC 4180 style). */
export function csvParseLine(line: string): string[] {
  const fields: string[] = [];
  const n = line.length;
  let i = 0;

  // A CSV record always yields at least one field (possibly empty).
  for (;;) {
    let value = '';

    if (i < n && line[i] === '"') {
      // Quoted field: iff the first character of the field is a double quote.
      i++; // consume the opening quote (removed from the value)

      while (i < n) {
        const ch = line[i];
        if (ch === '"') {
          // `""` inside a quoted field escapes to a single `"`.
          if (line[i + 1] === '"') {
            value += '"';
            i += 2;
            continue;
          }
          // A lone `"` closes the quoted field.
          i++; // consume the closing quote (removed from the value)
          break;
        }
        // Any other character (including commas) is literal inside quotes.
        value += ch;
        i++;
      }

      // Lenient handling of malformed input: any characters after the closing
      // quote but before the next separator are appended literally.
      while (i < n && line[i] !== ',') {
        value += line[i];
        i++;
      }
    } else {
      // Unquoted field: taken literally up to the next comma, including any
      // whitespace and any double quotes that are not at the start.
      while (i < n && line[i] !== ',') {
        value += line[i];
        i++;
      }
    }

    fields.push(value);

    if (i < n && line[i] === ',') {
      i++; // consume the field separator; another field follows.
      continue;
    }
    break;
  }

  return fields;
}
