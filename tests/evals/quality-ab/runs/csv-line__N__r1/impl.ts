/** Parse ONE CSV record (a single line) into its fields (RFC 4180 style). */
export function csvParseLine(line: string): string[] {
  const fields: string[] = [];
  const n = line.length;
  let i = 0;

  while (true) {
    if (line[i] === '"') {
      // Quoted field: consume the opening quote, then scan until the
      // matching (unescaped) closing quote, unescaping `""` to `"`.
      i++;
      let value = '';
      let closed = false;
      while (i < n) {
        const ch = line[i];
        if (ch === '"') {
          if (line[i + 1] === '"') {
            value += '"';
            i += 2;
          } else {
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
        throw new Error(`Unterminated quoted field in CSV line: ${line}`);
      }
      if (i < n && line[i] !== ',') {
        throw new Error(
          `Malformed CSV: expected comma or end of line after closing quote ` +
            `at position ${i} in line: ${line}`
        );
      }
      fields.push(value);
      if (i >= n) {
        break;
      }
      // line[i] === ',' here.
      i++;
      if (i === n) {
        fields.push('');
        break;
      }
    } else {
      // Unquoted field: taken literally up to the next comma or end of line.
      const start = i;
      while (i < n && line[i] !== ',') {
        i++;
      }
      fields.push(line.slice(start, i));
      if (i >= n) {
        break;
      }
      // line[i] === ',' here.
      i++;
      if (i === n) {
        fields.push('');
        break;
      }
    }
  }

  return fields;
}
