/** Parse ONE CSV record (a single line) into its fields (RFC 4180 style). */
export function csvParseLine(line: string): string[] {
  const fields: string[] = [];
  const n = line.length;
  let i = 0;

  while (true) {
    if (i < n && line[i] === '"') {
      // Quoted field: consume the opening quote, then scan until an
      // unescaped closing quote. A doubled quote ("") is an escaped
      // literal quote inside the field.
      i++;
      let value = '';
      while (i < n) {
        const ch = line[i];
        if (ch === '"') {
          if (i + 1 < n && line[i + 1] === '"') {
            value += '"';
            i += 2;
          } else {
            i++; // consume the closing quote
            break;
          }
        } else {
          value += ch;
          i++;
        }
      }
      fields.push(value);

      if (i < n && line[i] === ',') {
        i++;
        continue;
      }
      break;
    } else {
      // Unquoted field: literal up to the next comma (or end of line).
      const start = i;
      while (i < n && line[i] !== ',') {
        i++;
      }
      fields.push(line.slice(start, i));

      if (i < n && line[i] === ',') {
        i++;
        continue;
      }
      break;
    }
  }

  return fields;
}
