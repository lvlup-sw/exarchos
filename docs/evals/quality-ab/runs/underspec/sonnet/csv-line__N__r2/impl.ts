/** Parse ONE CSV record (a single line) into its fields (RFC 4180 style). */
export function csvParseLine(line: string): string[] {
  const fields: string[] = [];
  const n = line.length;
  let i = 0;

  while (true) {
    let value: string;

    if (line[i] === '"') {
      // Quoted field: a field is quoted iff its first character is `"`.
      i++; // consume opening quote
      let out = '';
      while (i < n) {
        const ch = line[i];
        if (ch === '"') {
          if (line[i + 1] === '"') {
            // `""` inside a quoted field unescapes to a single `"`.
            out += '"';
            i += 2;
          } else {
            // Unescaped `"` closes the quoted field.
            i++;
            break;
          }
        } else {
          out += ch;
          i++;
        }
      }
      value = out;

      // Lenient handling: skip any stray characters between the closing
      // quote and the next delimiter (malformed trailing content), so a
      // single bad quote can't swallow the rest of the record.
      while (i < n && line[i] !== ',') {
        i++;
      }
    } else {
      // Unquoted field: taken literally up to the next comma (or end of
      // line), including whitespace and any embedded double quotes.
      const start = i;
      while (i < n && line[i] !== ',') {
        i++;
      }
      value = line.slice(start, i);
    }

    fields.push(value);

    if (i < n && line[i] === ',') {
      i++;
      continue;
    }
    break;
  }

  return fields;
}
