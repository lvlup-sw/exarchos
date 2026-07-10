/** Parse ONE CSV record (a single line) into its fields (RFC 4180 style). */
export function csvParseLine(line: string): string[] {
  const fields: string[] = [];
  const n = line.length;
  let i = 0;

  while (true) {
    if (line[i] === '"') {
      // Quoted field: consume the opening quote, then scan for the closing
      // (unescaped) quote, unescaping "" -> " as we go. Commas encountered
      // here are part of the value, not separators.
      i++;
      let value = '';
      while (i < n) {
        const ch = line[i];
        if (ch === '"') {
          if (line[i + 1] === '"') {
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
    } else {
      // Unquoted field: taken literally up to the next comma (or end of line).
      const start = i;
      while (i < n && line[i] !== ',') {
        i++;
      }
      fields.push(line.slice(start, i));
    }

    if (i < n && line[i] === ',') {
      i++; // skip the separator; another field follows
      continue;
    }
    break;
  }

  return fields;
}
