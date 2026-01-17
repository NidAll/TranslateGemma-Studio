const LANG_CODE_RE = /^[a-z]{2,3}([_-][A-Za-z]{2})?$/;

export function normalizeLangCode(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || !LANG_CODE_RE.test(trimmed)) {
    return null;
  }

  const normalized = trimmed.replace("_", "-");
  const [language, region] = normalized.split("-");
  if (!region) {
    return language.toLowerCase();
  }

  return `${language.toLowerCase()}-${region.toUpperCase()}`;
}
