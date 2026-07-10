/** Parse ONE CSV record (a single line) into its fields (RFC 4180 style). */
export function csvParseLine(line: string): string[] {
  const fields: string[] = [];
  const n = line.length;
  let i = 0;

  while (true) {
    if (i < n && line[i] === '"') {
      // Quoted field.
      i++; // consume opening quote
      let value = '';
      let closed = false;

      while (i < n) {
        const ch = line[i];
        if (ch === '"') {
          if (i + 1 < n && line[i + 1] === '"') {
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
        throw new Error(`Unterminated quoted field at position ${i}`);
      }

      if (i < n) {
        if (line[i] === ',') {
          fields.push(value);
          i++;
          if (i === n) {
            fields.push('');
            break;
          }
          continue;
        }
        throw new Error(
          `Malformed CSV: unexpected character after closing quote at position ${i}`
        );
      }

      // End of line right after the closing quote.
      fields.push(value);
      break;
    }

    // Unquoted field: literal up to the next comma or end of line.
    const start = i;
    while (i < n && line[i] !== ',') {
      i++;
    }
    const value = line.slice(start, i);
    fields.push(value);

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
