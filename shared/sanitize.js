import languages from "./languages.js";

const languageNames = languages.map((lang) => lang.name);

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const labelPattern = new RegExp(
  `^\\s*(\\*\\*|\\*|__)?\\s*(${languageNames
    .map(escapeRegex)
    .join("|")})\\s*(\\*\\*|__)?\\s*[:\\-]\\s*`,
  "i"
);

const prefixPatterns = [
  /^here(?:'s| is) (?:the )?translation(?: of the provided text)?:/i,
  /^translated text:/i,
  /^translation:/i
];

function stripPrefix(text) {
  let current = text;
  for (const pattern of prefixPatterns) {
    if (pattern.test(current)) {
      current = current.replace(pattern, "");
    }
  }
  return current;
}

function stripLabelLine(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) {
    return text;
  }

  const first = lines[0];
  if (labelPattern.test(first)) {
    lines[0] = first.replace(labelPattern, "").trim();
    if (!lines[0]) {
      lines.shift();
    }
    return lines.join("\n");
  }

  return text;
}

function stripOuterQuotes(text) {
  if (text.length < 2) {
    return text;
  }
  const first = text[0];
  const last = text[text.length - 1];
  if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
    return text.slice(1, -1).trim();
  }
  return text;
}

export function sanitizeTranslation(input) {
  if (!input) {
    return "";
  }

  let text = String(input).trim();
  text = text.replace(/<\|file_separator\|>/g, "");
  text = text.replace(/<\|[^>]+?\|>/g, "");
  text = stripPrefix(text).trim();
  text = stripLabelLine(text).trim();
  text = stripOuterQuotes(text).trim();
  return text;
}
