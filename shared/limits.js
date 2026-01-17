export const DEFAULT_CONTEXT_TOKENS = 2048;
export const DEFAULT_MAX_OUTPUT_TOKENS = 512;
export const DEFAULT_PROMPT_OVERHEAD_TOKENS = 120;
export const DEFAULT_MIN_OUTPUT_TOKENS = 64;

const CJK_REGEX = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g;

export function estimateTokens(text) {
  if (!text) {
    return 0;
  }
  const raw = String(text);
  const total = raw.length;
  if (!total) {
    return 0;
  }
  const cjkCount = (raw.match(CJK_REGEX) || []).length;
  const ratio = cjkCount / total;
  const charsPerToken = ratio > 0.2 ? 1 : 4;
  return Math.ceil(total / charsPerToken);
}

export function safeMaxOutputTokens({
  contextTokens,
  maxOutputTokens,
  promptOverheadTokens
}) {
  const maxPossible = Math.max(0, contextTokens - promptOverheadTokens - 1);
  return Math.min(maxOutputTokens, maxPossible);
}

export function maxInputTokens({
  contextTokens,
  maxOutputTokens,
  promptOverheadTokens
}) {
  const safeMax = safeMaxOutputTokens({
    contextTokens,
    maxOutputTokens,
    promptOverheadTokens
  });
  return Math.max(0, contextTokens - safeMax - promptOverheadTokens);
}

export function clampOutputTokens({
  contextTokens,
  maxOutputTokens,
  promptOverheadTokens,
  inputTokens
}) {
  const available = contextTokens - promptOverheadTokens - inputTokens;
  return Math.max(0, Math.min(maxOutputTokens, available));
}
