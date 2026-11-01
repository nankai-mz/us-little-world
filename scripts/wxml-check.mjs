/** Source checks only; this deliberately does not claim to be the WeChat compiler. */
export function validateWxml(source, label = "WXML") {
  const errors = [];
  for (const match of source.matchAll(
    /wx:(if|elif|for)\s*=\s*(["'])(.*?)\2/gs,
  )) {
    const value = match[3].trim();
    if (
      !value.startsWith("{{") ||
      !value.endsWith("}}") ||
      value.slice(2, -2).trim() === ""
    ) {
      const line = source.slice(0, match.index).split("\n").length;
      errors.push(
        `${label}:${line}: wx:${match[1]} must use a non-empty {{ expression }}`,
      );
    }
  }
  for (const match of source.matchAll(
    /\b(?:disabled|loading|checked|hidden)\s*=\s*(["'])(false)\1/g,
  ))
    errors.push(`${label}: boolean false must be bound as {{false}}`);
  const stack = [];
  const withoutComments = source.replace(/<!--[\s\S]*?-->/g, "");
  for (const match of withoutComments.matchAll(
    /<(\/?)([\w:-]+)((?:[^>"']|"[^"]*"|'[^']*')*)>/g,
  )) {
    const [, closing, tag, attributes] = match;
    if (closing) {
      if (stack.pop() !== tag)
        errors.push(`${label}: unbalanced closing tag ${tag}`);
    } else if (!attributes.trimEnd().endsWith("/")) stack.push(tag);
  }
  if (stack.length) errors.push(`${label}: unclosed tags ${stack.join(", ")}`);
  return errors;
}
