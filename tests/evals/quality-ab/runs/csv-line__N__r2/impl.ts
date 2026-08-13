/** Parse ONE CSV record (a single line) into its fields (RFC 4180 style). */
export function csvParseLine(line: string): string[] {
  const fields: string[] = [];
  const n = line.length;
  let i = 0;

  for (;;) {
    if (line.charAt(i) === '"') {
      // Quoted field.
      i++; // skip opening quote
      let value = '';
      let closed = false;

      while (i < n) {
        const ch = line.charAt(i);
        if (ch === '"') {
          if (line.charAt(i + 1) === '"') {
            // Escaped quote.
            value += '"';
            i += 2;
            continue;
          }
          // Closing quote.
          i++;
          closed = true;
          break;
        }
        value += ch;
        i++;
      }

      if (!closed) {
        throw new Error(`Unterminated quoted field in CSV line: ${JSON.stringify(line)}`);
      }

      // After the closing quote, the next character must be a comma or the
      // end of the line.
      if (i < n && line.charAt(i) !== ',') {
        throw new Error(
          `Malformed CSV: expected comma or end of line after closing quote at index ${i} in ${JSON.stringify(line)}`,
        );
      }

      fields.push(value);
      if (i >= n) break;
      i++; // consume the comma
      continue;
    }

    // Unquoted field: literal text up to the next comma or end of line.
    const start = i;
    while (i < n && line.charAt(i) !== ',') {
      i++;
    }
    fields.push(line.slice(start, i));
    if (i >= n) break;
    i++; // consume the comma
  }

  return fields;
}
