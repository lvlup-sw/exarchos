/** Parse ONE CSV record (a single line) into its fields (RFC 4180 style). */
export function csvParseLine(line: string): string[] {
  const fields: string[] = [];
  const n = line.length;
  let i = 0;

  // Parse exactly one field per loop iteration; each iteration either
  // consumes a trailing comma (and continues) or hits end-of-line (and breaks).
  // A lone empty line therefore yields a single empty field: [''].
  while (true) {
    let value = '';

    if (i < n && line[i] === '"') {
      // Quoted field: a field is quoted iff its first char is a double quote.
      i++; // consume the opening quote (removed from the returned value)

      while (i < n) {
        const ch = line[i];
        if (ch === '"') {
          if (i + 1 < n && line[i + 1] === '"') {
            // Escaped quote: "" -> literal "
            value += '"';
            i += 2;
          } else {
            // Unescaped quote: the quoted field ends here.
            i++; // consume the closing quote
            break;
          }
        } else {
          value += ch;
          i++;
        }
      }

      // Lenient handling of any characters between the closing quote and the
      // next comma / end-of-line (e.g. `"a"b` -> `ab`): append them literally.
      // (An unterminated quote simply consumed the rest of the line above.)
      while (i < n && line[i] !== ',') {
        value += line[i];
        i++;
      }
    } else {
      // Unquoted field: taken literally, including whitespace and any
      // double quotes that are not at the very start (`a"b` -> `a"b`).
      while (i < n && line[i] !== ',') {
        value += line[i];
        i++;
      }
    }

    fields.push(value);

    if (i < n && line[i] === ',') {
      i++; // consume separator, parse the next field
      continue;
    }
    break; // end of line
  }

  return fields;
}
