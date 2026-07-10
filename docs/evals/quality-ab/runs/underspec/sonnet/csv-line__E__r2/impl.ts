/** Parse ONE CSV record (a single line) into its fields (RFC 4180 style). */
export function csvParseLine(line: string): string[] {
  const fields: string[] = [];
  const n = line.length;
  let i = 0;

  while (true) {
    let value: string;

    if (line[i] === '"') {
      // Quoted field: starts with a double quote, ends at the next
      // unescaped double quote. `""` inside unescapes to a literal `"`.
      i++; // consume opening quote
      value = '';
      while (i < n) {
        const ch = line[i];
        if (ch === '"') {
          if (line[i + 1] === '"') {
            value += '"';
            i += 2;
          } else {
            i++; // consume closing quote
            break;
          }
        } else {
          value += ch;
          i++;
        }
      }
      // Defensive: if there are stray characters between the closing quote
      // and the next comma (malformed input), absorb them into the value
      // rather than silently dropping data.
      while (i < n && line[i] !== ',') {
        value += line[i];
        i++;
      }
    } else {
      // Unquoted field: taken literally up to the next comma (or end of
      // line), including whitespace and any non-leading double quotes.
      const start = i;
      while (i < n && line[i] !== ',') {
        i++;
      }
      value = line.slice(start, i);
    }

    fields.push(value);

    if (i < n && line[i] === ',') {
      i++; // consume the separator and parse the next field
      continue;
    }
    break;
  }

  return fields;
}
