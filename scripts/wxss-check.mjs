/** Checks known unsupported selectors; not a replacement for the WXSS compiler. */
export function validateWxss(source, label = "WXSS") {
  const errors = [];
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of withoutComments.matchAll(/([^{}]+)\{/g)) {
    if (match[1].includes("*"))
      errors.push(`${label}: WXSS does not support universal selectors`);
  }
  return errors;
}
