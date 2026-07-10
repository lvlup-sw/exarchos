/** Parse ONE CSV record (a single line) into its fields (RFC 4180 style). */
export function csvParseLine(line: string): string[] {
  const fields: string[] = [];
  const n = line.length;
  let i = 0;

  for (;;) {
    if (line[i] === '"') {
      // Quoted field: consume the opening quote, then read until an
      // unescaped closing quote. A doubled quote ("") unescapes to a
      // single literal quote.
      i++;
      let value = '';
      while (i < n) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') {
            value += '"';
            i += 2;
          } else {
            // Unescaped quote: end of the quoted field.
            i++;
            break;
          }
        } else {
          value += line[i];
          i++;
        }
      }
      // Lenient handling of any trailing characters between the closing
      // quote and the next separator/end-of-line (not valid per RFC 4180,
      // but we skip them rather than throwing).
      while (i < n && line[i] !== ',') {
        i++;
      }
      fields.push(value);
    } else {
      // Unquoted field: taken literally up to the next comma (or end of
      // line), including any whitespace or embedded quotes.
      const start = i;
      while (i < n && line[i] !== ',') {
        i++;
      }
      fields.push(line.slice(start, i));
    }

    if (i < n && line[i] === ',') {
      i++;
      if (i === n) {
        // Trailing comma implies one more, empty, final field.
        fields.push('');
        break;
      }
      continue;
    }

    break;
  }

  return fields;
}
