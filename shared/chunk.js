import { estimateTokens } from "./limits.js";

const SENTENCE_REGEX =
  /[^.!?\u3002\uFF01\uFF1F\u0964\u0965\u061F\u06D4]+[.!?\u3002\uFF01\uFF1F\u0964\u0965\u061F\u06D4]+|[^.!?\u3002\uFF01\uFF1F\u0964\u0965\u061F\u06D4]+$/g;
const CLAUSE_REGEX =
  /[^,;:\u3001\uFF0C\uFF1B\uFF1A\u060C\u061B]+[,;:\u3001\uFF0C\uFF1B\uFF1A\u060C\u061B]+|[^,;:\u3001\uFF0C\uFF1B\uFF1A\u060C\u061B]+$/g;

function splitSentences(text) {
  const matches = text.match(SENTENCE_REGEX);
  if (!matches) {
    return [text.trim()];
  }
  return matches.map((part) => part.trim()).filter(Boolean);
}

function splitClauses(text) {
  const matches = text.match(CLAUSE_REGEX);
  if (!matches) {
    return [text.trim()];
  }
  return matches.map((part) => part.trim()).filter(Boolean);
}

function sliceByTokenLimit(text, limit) {
  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let low = 1;
    let high = text.length - start;
    let best = 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = text.slice(start, start + mid);
      const tokens = estimateTokens(candidate);
      if (tokens <= limit) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const slice = text.slice(start, start + best).trim();
    if (slice) {
      chunks.push(slice);
    }
    start += best;
  }

  return chunks;
}

function mergeSegments(segments, limit) {
  const chunks = [];
  let current = "";

  for (const segment of segments) {
    if (!segment) {
      continue;
    }

    const next = current ? `${current} ${segment}` : segment;
    if (estimateTokens(next) <= limit) {
      current = next;
      continue;
    }

    if (current) {
      chunks.push(current.trim());
      current = "";
    }

    if (estimateTokens(segment) > limit) {
      chunks.push(...sliceByTokenLimit(segment, limit));
    } else {
      current = segment;
    }
  }

  if (current) {
    chunks.push(current.trim());
  }

  return chunks;
}

function chunkOversizedSentence(sentence, limit) {
  const clauses = splitClauses(sentence);
  if (clauses.length > 1) {
    return mergeSegments(clauses, limit);
  }
  return sliceByTokenLimit(sentence, limit);
}

function chunkParagraph(text, limit) {
  if (estimateTokens(text) <= limit) {
    return [text.trim()];
  }

  const sentences = splitSentences(text);
  return mergeSegments(
    sentences.flatMap((sentence) => {
      if (estimateTokens(sentence) > limit) {
        return chunkOversizedSentence(sentence, limit);
      }
      return [sentence];
    }),
    limit
  );
}

export function chunkText(text, limit) {
  if (!limit || limit <= 0) {
    return [];
  }
  const normalized = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

  if (!normalized) {
    return [];
  }

  const pieces = normalized.split(/(\n{2,})/);
  const chunks = [];
  let pendingSeparator = "";

  for (const piece of pieces) {
    if (!piece) {
      continue;
    }
    if (/^\n{2,}$/.test(piece)) {
      pendingSeparator += piece;
      continue;
    }

    const paragraphChunks = chunkParagraph(piece.trim(), limit);
    for (let index = 0; index < paragraphChunks.length; index += 1) {
      const paragraphChunk = paragraphChunks[index];
      if (!paragraphChunk) {
        continue;
      }
      const isLast = index === paragraphChunks.length - 1;
      chunks.push({ text: paragraphChunk, separator: isLast ? "" : " " });
    }

    if (pendingSeparator && chunks.length) {
      chunks[chunks.length - 1].separator += pendingSeparator;
    }
    pendingSeparator = "";
  }

  return chunks;
}
