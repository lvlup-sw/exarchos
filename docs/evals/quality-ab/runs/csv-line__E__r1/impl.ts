/** Parse ONE CSV record (a single line) into its fields (RFC 4180 style). */
export function csvParseLine(line: string): string[] {
  const fields: string[] = [];
  const n = line.length;
  let i = 0;

  while (true) {
    if (i < n && line[i] === '"') {
      // Quoted field: skip opening quote, accumulate until an unescaped closing quote.
      i++;
      let value = '';
      let closed = false;

      while (i < n) {
        const ch = line[i];
        if (ch === '"') {
          if (i + 1 < n && line[i + 1] === '"') {
            // Escaped quote (`""` -> `"`).
            value += '"';
            i += 2;
          } else {
            // Closing quote.
            i++;
            closed = true;
            break;
          }
        } else {
          value += ch;
          i++;
        }
      }

      if (!closed) {
        throw new Error(`Unterminated quoted field at position ${i}`);
      }

      // After the closing quote, the next character must be a comma or end of line.
      if (i >= n) {
        fields.push(value);
        break;
      }
      if (line[i] !== ',') {
        throw new Error(
          `Malformed CSV: unexpected character after closing quote at position ${i}`,
        );
      }
      fields.push(value);
      i++; // consume comma
      if (i === n) {
        // Trailing comma yields a trailing empty field.
        fields.push('');
        break;
      }
      continue;
    }

    // Unquoted field: literal text up to the next comma or end of line.
    const start = i;
    while (i < n && line[i] !== ',') {
      i++;
    }
    fields.push(line.slice(start, i));

    if (i >= n) {
      break;
    }
    i++; // consume comma
    if (i === n) {
      fields.push('');
      break;
    }
  }

  return fields;
}
