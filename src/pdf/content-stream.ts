// A content-stream lexer, not a regular-expression substitution: strings can
// contain escaped parentheses, operator names, and arbitrary font bytes.
export function removePdfText(bytes: Uint8Array): Uint8Array | undefined {
  const source = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  let index = 0, operands = 0, copied = 0, output = "";
  const whitespace = (character: string) => /[\x00\t\n\f\r ]/u.test(character);
  const delimiter = (character: string) => !character || whitespace(character) || /[()[\]<>/%]/u.test(character);
  const skip = (): void => {
    while (index < source.length) {
      if (whitespace(source[index])) index++;
      else if (source[index] === "%") { while (index < source.length && !/[\r\n]/u.test(source[index])) index++; }
      else break;
    }
  };
  const object = (): boolean => {
    const start = source[index++];
    if (start === "(") {
      let depth = 1;
      while (index < source.length && depth) {
        const c = source[index++];
        if (c === "\\") index++;
        else if (c === "(") depth++;
        else if (c === ")") depth--;
      }
      return depth === 0;
    }
    if (start === "[" || (start === "<" && source[index] === "<")) {
      const end = start === "[" ? "]" : ">>";
      if (start === "<") index++;
      while (index < source.length) {
        skip();
        if (source.startsWith(end, index)) { index += end.length; return true; }
        if ("([<".includes(source[index])) { if (!object()) return false; }
        else { index++; while (index < source.length && !delimiter(source[index])) index++; }
      }
      return false;
    }
    if (start === "<") {
      const end = source.indexOf(">", index);
      if (end < 0) return false;
      index = end + 1; return true;
    }
    return false;
  };
  while (index < source.length) {
    skip();
    if (index >= source.length) break;
    const start = index;
    if ("([<".includes(source[index])) { if (!object()) return undefined; continue; }
    if (source[index] === "/") { index++; while (index < source.length && !delimiter(source[index])) index++; continue; }
    index++; while (index < source.length && !delimiter(source[index])) index++;
    const token = source.slice(start, index);
    if (/^[-+]?\d*\.?\d+$/u.test(token) || /^(?:true|false|null)$/u.test(token)) continue;
    // Inline images have opaque byte data; text-clipping objects can mask
    // subsequent graphics. Keep their already-rendered appearance unchanged.
    if (token === "BI" || (token === "Tr" && Number(source.slice(operands, start).trim()) >= 4)) return undefined;
    if (["Tj", "TJ", "'", '"', "Tf"].includes(token)) {
      output += source.slice(copied, operands);
      copied = index;
    }
    operands = index;
  }
  return Uint8Array.from(output + source.slice(copied), (character) => character.charCodeAt(0));
}
