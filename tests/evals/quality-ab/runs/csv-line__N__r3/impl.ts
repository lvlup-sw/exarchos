/** Parse ONE CSV record (a single line) into its fields (RFC 4180 style). */
export function csvParseLine(line: string): string[] {
  const fields: string[] = [];
  const n = line.length;
  let i = 0;

  while (true) {
    if (i < n && line[i] === '"') {
      // Quoted field: consume the opening quote, then read until an
      // unescaped closing quote, unescaping "" -> " along the way.
      i++;
      let value = '';
      let closed = false;

      while (i < n) {
        const ch = line[i];
        if (ch === '"') {
          if (i + 1 < n && line[i + 1] === '"') {
            value += '"';
            i += 2;
            continue;
          }
          closed = true;
          i++;
          break;
        }
        value += ch;
        i++;
      }

      if (!closed) {
        throw new Error('Unterminated quoted field in CSV line');
      }

      if (i >= n) {
        fields.push(value);
        break;
      }

      if (line[i] !== ',') {
        throw new Error(
          `Malformed CSV: unexpected character after closing quote at position ${i}`
        );
      }

      fields.push(value);
      i++;
      if (i === n) {
        // Trailing comma yields a trailing empty field.
        fields.push('');
        break;
      }
      continue;
    }

    // Unquoted field: literal text up to the next comma or end of line.
    let value = '';
    while (i < n && line[i] !== ',') {
      value += line[i];
      i++;
    }
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
