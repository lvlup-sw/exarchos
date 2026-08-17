/** Parse ONE CSV record (a single line) into its fields (RFC 4180 style). */
export function csvParseLine(line: string): string[] {
  const fields: string[] = [];
  const n = line.length;
  let i = 0;

  // Parse exactly one field per outer iteration. A trailing comma or an empty
  // line therefore yields a trailing/sole empty field, matching CSV semantics.
  for (;;) {
    let field = '';

    if (i < n && line[i] === '"') {
      // Quoted field: the very first character is a double quote.
      i++; // consume the opening quote (it is stripped from the value).

      let closed = false;
      while (i < n) {
        const c = line[i];
        if (c === '"') {
          if (i + 1 < n && line[i + 1] === '"') {
            // Escaped quote ("") -> a single literal quote.
            field += '"';
            i += 2;
          } else {
            // Unescaped quote -> end of the quoted section.
            i++;
            closed = true;
            break;
          }
        } else {
          field += c;
          i++;
        }
      }

      // Any characters between the closing quote and the next comma are not
      // defined by RFC 4180; append them literally so no input is silently
      // dropped (e.g. `"a"b` -> `ab`). An unterminated quote (no closing quote
      // before end-of-line) simply consumes the remainder as the value.
      if (closed) {
        while (i < n && line[i] !== ',') {
          field += line[i];
          i++;
        }
      }
    } else {
      // Unquoted field: taken literally up to the next comma. Whitespace and
      // any non-leading double quotes are preserved verbatim.
      while (i < n && line[i] !== ',') {
        field += line[i];
        i++;
      }
    }

    fields.push(field);

    if (i < n && line[i] === ',') {
      i++; // consume the separator and parse the next field.
      continue;
    }
    break;
  }

  return fields;
}
