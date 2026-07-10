/** Parse ONE CSV record (a single line) into its fields (RFC 4180 style). */
export function csvParseLine(line: string): string[] {
  const fields: string[] = [];
  const n = line.length;
  let i = 0;

  // Parse exactly one field per outer iteration. A trailing comma therefore
  // produces a final empty field (e.g. "a," -> ["a", ""]), matching CSV semantics.
  while (true) {
    let field = '';

    // A field is quoted iff its FIRST character is a double quote.
    if (i < n && line[i] === '"') {
      i++; // consume the opening quote (removed from the value)

      while (i < n) {
        const ch = line[i];
        if (ch === '"') {
          // A doubled quote inside a quoted field is a literal single quote.
          if (i + 1 < n && line[i + 1] === '"') {
            field += '"';
            i += 2;
          } else {
            // Unescaped quote -> closing quote; the quoted region ends here.
            i++;
            break;
          }
        } else {
          // Commas (and everything else) are part of the value while quoted.
          field += ch;
          i++;
        }
      }

      // Any characters between the closing quote and the next comma (or EOL)
      // are appended literally. This is a tolerant handling of otherwise
      // malformed input like `"a"b` -> `ab`.
      while (i < n && line[i] !== ',') {
        field += line[i];
        i++;
      }
    } else {
      // Unquoted field: taken literally until the next comma (or EOL),
      // including whitespace and any non-leading double quotes.
      while (i < n && line[i] !== ',') {
        field += line[i];
        i++;
      }
    }

    fields.push(field);

    if (i < n && line[i] === ',') {
      i++; // consume the separator and parse the next field
      continue;
    }
    break;
  }

  return fields;
}
