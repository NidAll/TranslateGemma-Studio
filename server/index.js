import express from "express";
import next from "next";
import { Readable } from "node:stream";
import { ensureLlamaServer, LLAMA_SERVER_URL } from "./llama.js";
import { detectLanguage } from "./fasttext.js";
import { normalizeLangCode } from "./lang.js";
import languages from "../shared/languages.js";
import { sanitizeTranslation } from "../shared/sanitize.js";
import {
  clampOutputTokens,
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_PROMPT_OVERHEAD_TOKENS,
  estimateTokens,
  maxInputTokens,
  safeMaxOutputTokens
} from "../shared/limits.js";

process.env.NEXT_TELEMETRY_DISABLED =
  process.env.NEXT_TELEMETRY_DISABLED || "1";

const dev = process.env.NODE_ENV !== "production";
const app = next({ dev });
const handle = app.getRequestHandler();
const port = Number(process.env.PORT || 3000);

await app.prepare();

const server = express();
server.use(express.json({ limit: "2mb" }));

const PROMPT_MODE = (process.env.LLAMA_PROMPT_MODE || "plain").toLowerCase();
const CONTEXT_TOKENS = Number(
  process.env.LLAMA_CONTEXT_TOKENS || DEFAULT_CONTEXT_TOKENS
);
const MAX_OUTPUT_TOKENS = Number(
  process.env.LLAMA_MAX_OUTPUT_TOKENS || DEFAULT_MAX_OUTPUT_TOKENS
);
const PROMPT_OVERHEAD_TOKENS = Number(
  process.env.LLAMA_PROMPT_OVERHEAD_TOKENS || DEFAULT_PROMPT_OVERHEAD_TOKENS
);
const SAFE_MAX_OUTPUT_TOKENS = safeMaxOutputTokens({
  contextTokens: CONTEXT_TOKENS,
  maxOutputTokens: MAX_OUTPUT_TOKENS,
  promptOverheadTokens: PROMPT_OVERHEAD_TOKENS
});
const LANGUAGE_NAME_BY_CODE = new Map(
  languages.map((language) => [language.code.toLowerCase(), language.name])
);

function languageName(code) {
  if (!code) {
    return "Unknown";
  }
  return LANGUAGE_NAME_BY_CODE.get(code.toLowerCase()) || code;
}

function buildPrompt(sourceCode, targetCode, text) {
  const sourceName = languageName(sourceCode);
  const targetName = languageName(targetCode);
  return [
    `You are a professional ${sourceName} (${sourceCode}) to ${targetName} (${targetCode}) translator.`,
    `Your goal is to accurately convey the meaning and nuances of the original ${sourceName} text.`,
    `Produce only the ${targetName} translation without labels, quotes, commentary, or language names.`,
    `Translate the following ${sourceName} text into ${targetName}:`,
    "",
    text
  ].join("\n");
}

server.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

server.post("/api/detect", async (req, res) => {
  const inputText = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!inputText) {
    return res.status(400).json({ error: "Text is required." });
  }

  try {
    const detection = await detectLanguage(inputText);
    return res.json({
      detectedSourceLang: detection.code,
      detectedSourceName: languageName(detection.code),
      probability: detection.probability
    });
  } catch (err) {
    return res.status(500).json({
      error: "Language detection failed.",
      details: err.message || String(err)
    });
  }
});

server.post("/api/translate", async (req, res) => {
  const { sourceLang, targetLang, text } = req.body || {};
  const rawSource = typeof sourceLang === "string" ? sourceLang.trim() : "";
  const wantsAuto = rawSource.toLowerCase() === "auto";
  let normalizedSource = wantsAuto ? null : normalizeLangCode(rawSource);
  const normalizedTarget = normalizeLangCode(targetLang);
  const inputText = typeof text === "string" ? text.trim() : "";
  const wantsStream = Boolean(req.body?.stream);
  const inputTokens = estimateTokens(inputText);
  const inputTokenLimit = maxInputTokens({
    contextTokens: CONTEXT_TOKENS,
    maxOutputTokens: SAFE_MAX_OUTPUT_TOKENS,
    promptOverheadTokens: PROMPT_OVERHEAD_TOKENS
  });

  if (!normalizedTarget) {
    return res.status(400).json({
      error: "Invalid target language code. Use ISO 639-1 with optional region."
    });
  }

  if (!inputText) {
    return res.status(400).json({ error: "Text is required." });
  }

  if (inputTokens > inputTokenLimit) {
    return res.status(413).json({
      error: "Input is too long for the model context window.",
      details: `Estimated ${inputTokens} tokens, limit ${inputTokenLimit} tokens.`
    });
  }

  let detectedSource = null;
  if (wantsAuto) {
    try {
      const detection = await detectLanguage(inputText);
      detectedSource = {
        code: detection.code,
        name: languageName(detection.code),
        probability: detection.probability
      };
      normalizedSource = normalizeLangCode(detection.code);
    } catch (err) {
      return res.status(500).json({
        error: "Language detection failed.",
        details: err.message || String(err)
      });
    }
  }

  if (!normalizedSource) {
    return res.status(400).json({
      error:
        "Invalid source language code. Use ISO 639-1 with optional region, or auto."
    });
  }

  try {
    await ensureLlamaServer();

    const message =
      PROMPT_MODE === "structured"
        ? {
            role: "user",
            content: [
              {
                type: "text",
                source_lang_code: normalizedSource,
                target_lang_code: normalizedTarget,
                text: inputText
              }
            ]
          }
        : {
            role: "user",
            content: buildPrompt(normalizedSource, normalizedTarget, inputText)
          };

    const payload = {
      messages: [message],
      temperature: 0,
      top_p: 1,
      repeat_penalty: 1.05,
      max_tokens: clampOutputTokens({
        contextTokens: CONTEXT_TOKENS,
        maxOutputTokens: SAFE_MAX_OUTPUT_TOKENS,
        promptOverheadTokens: PROMPT_OVERHEAD_TOKENS,
        inputTokens
      }),
      stream: wantsStream
    };

    const controller = new AbortController();
    req.on("close", () => controller.abort());

    const response = await fetch(`${LLAMA_SERVER_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (wantsStream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      res.flushHeaders?.();

      if (detectedSource) {
        res.write(
          `data: ${JSON.stringify({
            detectedSourceLang: detectedSource.code,
            detectedSourceName: detectedSource.name,
            probability: detectedSource.probability
          })}\n\n`
        );
      }

      if (!response.ok) {
        const detail = await response.text();
        res.write(
          `data: ${JSON.stringify({
            error: "llama.cpp returned an error.",
            details: detail
          })}\n\n`
        );
        res.write("data: [DONE]\n\n");
        return res.end();
      }

      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text/event-stream")) {
        let fallbackText = "";
        try {
          const result = await response.json();
          fallbackText = result?.choices?.[0]?.message?.content || "";
        } catch (err) {
          fallbackText = await response.text();
        }
        const cleaned = sanitizeTranslation(fallbackText);
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { content: cleaned } }]
          })}\n\n`
        );
        res.write("data: [DONE]\n\n");
        return res.end();
      }

      if (!response.body) {
        res.write(
          `data: ${JSON.stringify({
            error: "llama.cpp did not return a streaming body."
          })}\n\n`
        );
        res.write("data: [DONE]\n\n");
        return res.end();
      }

      const stream = Readable.fromWeb(response.body);
      stream.on("data", (chunk) => res.write(chunk));
      stream.on("end", () => res.end());
      stream.on("error", (err) => {
        res.write(
          `data: ${JSON.stringify({
            error: "Streaming failed.",
            details: err.message || String(err)
          })}\n\n`
        );
        res.write("data: [DONE]\n\n");
        res.end();
      });
      return;
    }

    if (!response.ok) {
      const detail = await response.text();
      return res.status(502).json({
        error: "llama.cpp returned an error.",
        details: detail
      });
    }

    const result = await response.json();
    const translation = sanitizeTranslation(
      result?.choices?.[0]?.message?.content || ""
    );

    return res.json({
      translation,
      sourceLang: normalizedSource,
      targetLang: normalizedTarget,
      detectedSourceLang: detectedSource?.code || null,
      detectedSourceName: detectedSource?.name || null,
      probability: detectedSource?.probability ?? null
    });
  } catch (err) {
    if (wantsStream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      res.write(
        `data: ${JSON.stringify({
          error: "Translation failed.",
          details: err.message || String(err)
        })}\n\n`
      );
      res.write("data: [DONE]\n\n");
      return res.end();
    }

    return res.status(500).json({
      error: "Translation failed.",
      details: err.message || String(err)
    });
  }
});

server.all("*", (req, res) => handle(req, res));

server.listen(port, () => {
  console.log(`TranslateGemma UI running on http://127.0.0.1:${port}`);
});

ensureLlamaServer().catch((err) => {
  console.error("Failed to start llama-server:", err.message || err);
});
