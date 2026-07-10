/** Parse ONE CSV record (a single line) into its fields (RFC 4180 style). */
export function csvParseLine(line: string): string[] {
  const fields: string[] = [];
  const n = line.length;
  let i = 0;

  // A record always has at least one field (an empty line -> [""]).
  // We parse field-by-field, consuming a separating comma between fields.
  for (;;) {
    let value = '';

    if (line[i] === '"') {
      // Quoted field: first char is a double quote.
      i++; // consume the opening quote
      while (i < n) {
        const ch = line[i];
        if (ch === '"') {
          if (line[i + 1] === '"') {
            // Escaped quote ("") -> literal single quote.
            value += '"';
            i += 2;
          } else {
            // Unescaped quote terminates the quoted section.
            i++; // consume the closing quote
            break;
          }
        } else {
          value += ch;
          i++;
        }
      }
      // Lenient handling of any stray characters after the closing quote
      // (before the next comma / end of line): treat them literally so we
      // never lose data on malformed input.
      while (i < n && line[i] !== ',') {
        value += line[i];
        i++;
      }
    } else {
      // Unquoted field: taken literally up to the next comma / end of line.
      // Whitespace and non-leading double quotes are preserved verbatim.
      while (i < n && line[i] !== ',') {
        value += line[i];
        i++;
      }
    }

    fields.push(value);

    if (i < n && line[i] === ',') {
      i++; // consume the field separator and continue with the next field
      continue;
    }
    break;
  }

  return fields;
}
