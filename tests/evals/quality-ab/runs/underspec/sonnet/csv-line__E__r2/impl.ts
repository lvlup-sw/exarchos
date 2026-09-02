/** Parse ONE CSV record (a single line) into its fields (RFC 4180 style). */
export function csvParseLine(line: string): string[] {
  const fields: string[] = [];
  const n = line.length;
  let i = 0;

  while (true) {
    if (i < n && line[i] === '"') {
      // Quoted field: starts with a double quote.
      i++; // consume opening quote
      let value = '';
      while (i < n) {
        const ch = line[i];
        if (ch === '"') {
          if (i + 1 < n && line[i + 1] === '"') {
            // Escaped quote inside a quoted field -> literal '"'.
            value += '"';
            i += 2;
          } else {
            // Closing quote.
            i++;
            break;
          }
        } else {
          value += ch;
          i++;
        }
      }
      fields.push(value);

      // Skip any trailing characters until the next comma or end of line
      // (defensive: tolerates malformed input rather than throwing).
      while (i < n && line[i] !== ',') {
        i++;
      }
    } else {
      // Unquoted field: literal up to the next comma.
      const start = i;
      while (i < n && line[i] !== ',') {
        i++;
      }
      fields.push(line.slice(start, i));
    }

    if (i < n && line[i] === ',') {
      i++; // consume separator, another field follows
      continue;
    }
    break;
  }

  return fields;
}
