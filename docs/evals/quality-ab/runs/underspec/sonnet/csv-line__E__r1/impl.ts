/** Parse ONE CSV record (a single line) into its fields (RFC 4180 style). */
export function csvParseLine(line: string): string[] {
  const fields: string[] = [];
  const n = line.length;
  let i = 0;

  while (true) {
    if (line.charAt(i) === '"') {
      // Quoted field: a field is quoted iff its first character is a
      // double quote. It runs until the next unescaped closing quote;
      // `""` inside the field unescapes to a single literal `"`.
      i++; // skip opening quote
      let value = '';
      while (i < n) {
        const c = line.charAt(i);
        if (c === '"') {
          if (line.charAt(i + 1) === '"') {
            value += '"';
            i += 2;
          } else {
            i++; // consume the (unescaped) closing quote
            break;
          }
        } else {
          value += c;
          i++;
        }
      }
      fields.push(value);

      // After the closing quote, advance to the next field separator.
      // (Any characters between the closing quote and the next comma are
      // not specified by well-formed input; skip defensively rather than
      // silently dropping data or throwing.)
      while (i < n && line.charAt(i) !== ',') {
        i++;
      }
      if (i < n) {
        i++; // consume the comma
        continue;
      }
      break;
    }

    // Unquoted field: taken literally up to the next comma (or end of
    // line), including any whitespace and any double quotes that are not
    // the very first character of the field.
    const start = i;
    while (i < n && line.charAt(i) !== ',') {
      i++;
    }
    fields.push(line.slice(start, i));
    if (i < n) {
      i++; // consume the comma
      continue;
    }
    break;
  }

  return fields;
}
