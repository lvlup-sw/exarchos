/** Parse ONE CSV record (a single line) into its fields (RFC 4180 style). */
export function csvParseLine(line: string): string[] {
  const fields: string[] = [];
  const n = line.length;
  let i = 0;

  for (;;) {
    if (i < n && line[i] === '"') {
      // Quoted field.
      i++; // consume opening quote
      let value = '';
      let closed = false;

      while (i < n) {
        const ch = line[i];
        if (ch === '"') {
          if (i + 1 < n && line[i + 1] === '"') {
            // Escaped quote: "" -> literal "
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
        throw new Error(
          `csvParseLine: unterminated quoted field in line: ${line}`,
        );
      }

      if (i >= n) {
        fields.push(value);
        break;
      }

      if (line[i] === ',') {
        fields.push(value);
        i++;
        if (i === n) {
          // Trailing comma yields a trailing empty field.
          fields.push('');
          break;
        }
        continue;
      }

      throw new Error(
        `csvParseLine: unexpected character after quoted field at position ${i} in line: ${line}`,
      );
    }

    // Unquoted field: literal up to the next comma or end of line.
    const start = i;
    while (i < n && line[i] !== ',') {
      i++;
    }
    fields.push(line.slice(start, i));

    if (i < n && line[i] === ',') {
      i++;
      if (i === n) {
        fields.push('');
        break;
      }
      continue;
    }

    break;
  }

  return fields;
}
