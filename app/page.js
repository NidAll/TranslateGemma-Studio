"use client";

import { useEffect, useRef, useState } from "react";
import languages from "../shared/languages.js";
import { sanitizeTranslation } from "../shared/sanitize.js";
import {
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_PROMPT_OVERHEAD_TOKENS,
  estimateTokens,
  maxInputTokens
} from "../shared/limits.js";
import { chunkText } from "../shared/chunk.js";

export default function Home() {
  const [sourceLang, setSourceLang] = useState("en");
  const [targetLang, setTargetLang] = useState("es");
  const [inputText, setInputText] = useState("");
  const [outputText, setOutputText] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [chunkingEnabled, setChunkingEnabled] = useState(false);
  const [chunkStatus, setChunkStatus] = useState("");
  const [detectedLang, setDetectedLang] = useState("");
  const [detectedLangName, setDetectedLangName] = useState("");
  const [copied, setCopied] = useState(false);
  const [theme, setTheme] = useState("light");
  const abortRef = useRef(null);
  const inputTokenLimit = maxInputTokens({
    contextTokens: DEFAULT_CONTEXT_TOKENS,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    promptOverheadTokens: DEFAULT_PROMPT_OVERHEAD_TOKENS
  });
  const inputTokenCount = estimateTokens(inputText);
  const sourceOptions = [{ code: "auto", name: "Auto detect" }, ...languages];

  useEffect(() => {
    const stored = window.localStorage.getItem("theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const initial = stored || (prefersDark ? "dark" : "light");
    setTheme(initial);
    document.documentElement.dataset.theme = initial;
  }, []);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    window.localStorage.setItem("theme", next);
    document.documentElement.dataset.theme = next;
  };

  useEffect(() => {
    if (sourceLang !== "auto") {
      setDetectedLang("");
      setDetectedLangName("");
    }
  }, [sourceLang]);

  const handleSwap = () => {
    if (sourceLang === "auto") {
      return;
    }
    setSourceLang(targetLang);
    setTargetLang(sourceLang);
    setError("");
  };

  const finalize = () => {
    setIsLoading(false);
    abortRef.current = null;
    setChunkStatus("");
  };

  const detectLanguage = async (text, signal) => {
    const response = await fetch("/api/detect", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ text }),
      signal
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(
        payload?.details || payload?.error || "Language detection failed."
      );
    }

    const payload = await response.json();
    const detectedSourceLang = payload?.detectedSourceLang || "";
    if (!detectedSourceLang) {
      throw new Error("Unable to detect the source language.");
    }

    return {
      code: detectedSourceLang,
      name: payload?.detectedSourceName || detectedSourceLang
    };
  };

  const translateOnce = async (
    text,
    signal,
    sourceOverride,
    targetOverride
  ) => {
    const response = await fetch("/api/translate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        sourceLang: sourceOverride || sourceLang,
        targetLang: targetOverride || targetLang,
        text,
        stream: false
      }),
      signal
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload?.details || payload?.error || "Translation failed.");
    }

    const payload = await response.json();
    return sanitizeTranslation(payload?.translation || "");
  };

  const streamTranslation = async ({
    text,
    signal,
    sourceOverride,
    targetOverride,
    onPartial,
    onMeta
  }) => {
    const response = await fetch("/api/translate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream"
      },
      body: JSON.stringify({
        sourceLang: sourceOverride || sourceLang,
        targetLang: targetOverride || targetLang,
        text,
        stream: true
      }),
      signal
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload?.details || payload?.error || "Translation failed.");
    }

    if (!response.body) {
      const fallback = await translateOnce(
        text,
        signal,
        sourceOverride,
        targetOverride
      );
      if (onPartial) {
        onPartial(fallback);
      }
      return fallback;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let assembled = "";
    let lastCleaned = "";

    const pushDelta = (delta) => {
      if (!delta) {
        return;
      }
      assembled += delta;
      const cleaned = sanitizeTranslation(assembled);
      if (cleaned !== lastCleaned) {
        lastCleaned = cleaned;
        if (onPartial) {
          onPartial(cleaned);
        }
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r/g, "");

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const lines = rawEvent.split("\n");
        for (const line of lines) {
          if (!line.startsWith("data:")) {
            continue;
          }
          const data = line.replace(/^data:\s*/, "");
          if (!data) {
            continue;
          }
          if (data === "[DONE]") {
            return sanitizeTranslation(assembled);
          }

          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch (err) {
            continue;
          }

          if (parsed?.error) {
            throw new Error(parsed.error);
          }

          if (parsed?.detectedSourceLang && onMeta) {
            onMeta({
              detectedSourceLang: parsed.detectedSourceLang,
              detectedSourceName: parsed.detectedSourceName || ""
            });
          }

          const delta =
            parsed?.choices?.[0]?.delta?.content ??
            parsed?.choices?.[0]?.delta?.text ??
            parsed?.choices?.[0]?.text ??
            "";

          pushDelta(delta);
        }
        boundary = buffer.indexOf("\n\n");
      }
    }

    return sanitizeTranslation(assembled);
  };

  const translateChunked = async (signal, sourceOverride, targetOverride) => {
    const chunks = chunkText(inputText, inputTokenLimit);
    if (!chunks.length) {
      return;
    }

    let assembled = "";
    for (let index = 0; index < chunks.length; index += 1) {
      if (signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      if (chunks.length > 1) {
        setChunkStatus(`Chunk ${index + 1} of ${chunks.length}`);
      }
      const base = assembled;
      const separator = chunks[index].separator || "";
      const translation = await streamTranslation({
        text: chunks[index].text,
        signal,
        sourceOverride,
        targetOverride,
        onPartial: (partial) => {
          setOutputText(base + partial);
        }
      });

      if (translation) {
        assembled += translation;
      }
      if (separator && (assembled || translation)) {
        assembled += separator;
      }
      setOutputText(assembled);
    }
  };

  const handleTranslate = async () => {
    if (!inputText.trim()) {
      return;
    }
    if (!chunkingEnabled && inputTokenCount > inputTokenLimit) {
      return;
    }
    if (abortRef.current) {
      abortRef.current.abort();
    }

    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    setError("");
    setCopied(false);
    setChunkStatus("");
    setOutputText("");
    if (sourceLang === "auto") {
      setDetectedLang("");
      setDetectedLangName("");
    }

    try {
      let effectiveSource = sourceLang;
      if (sourceLang === "auto") {
        const detected = await detectLanguage(inputText, controller.signal);
        effectiveSource = detected.code;
        setDetectedLang(detected.code);
        setDetectedLangName(detected.name);
      }

      if (chunkingEnabled) {
        await translateChunked(controller.signal, effectiveSource, targetLang);
      } else {
        const finalText = await streamTranslation({
          text: inputText,
          signal: controller.signal,
          sourceOverride: effectiveSource,
          targetOverride: targetLang,
          onPartial: (partial) => setOutputText(partial),
          onMeta: (meta) => {
            if (meta?.detectedSourceLang) {
              setDetectedLang(meta.detectedSourceLang);
              setDetectedLangName(meta.detectedSourceName || "");
            }
          }
        });
        setOutputText(finalText);
      }
    } catch (err) {
      if (err.name === "AbortError") {
        return;
      }
      setOutputText("");
      setError(err.message || "Translation failed.");
    } finally {
      finalize();
    }
  };

  const handleStop = () => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    finalize();
  };

  const handleCopy = async () => {
    if (!outputText) {
      return;
    }
    try {
      await navigator.clipboard.writeText(outputText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch (err) {
      setCopied(false);
    }
  };

  const isBusy = isLoading;
  const overLimit = inputTokenCount > inputTokenLimit;
  const tokenClass = overLimit
    ? chunkingEnabled
      ? "limit-soft"
      : "limit-hit"
    : "muted";
  const warningClass = overLimit
    ? chunkingEnabled
      ? "limit-soft"
      : "limit-hit"
    : "muted";
  const inputWarning = overLimit
    ? chunkingEnabled
      ? "Long text mode will split this into smaller chunks."
      : "Input exceeds the context limit. Enable long text mode to auto-chunk."
    : "";
  const sourceTag =
    sourceLang === "auto" ? detectedLang || "auto" : sourceLang;
  const detectionNote =
    sourceLang === "auto" && detectedLang
      ? `Detected source: ${detectedLangName || detectedLang} (${detectedLang})`
      : "";

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="badge">TranslateGemma</span>
          <p className="brand-subtitle">Local translation, text-only</p>
        </div>
        <div className="top-actions">
          <button className="ghost" type="button" onClick={toggleTheme}>
            {theme === "dark" ? "Light mode" : "Dark mode"}
          </button>
        </div>
      </header>

      <section className="controls">
        <div className="lang-grid">
          <label>
            From
            <select
              value={sourceLang}
              onChange={(event) => setSourceLang(event.target.value)}
            >
              {sourceOptions.map((language) => (
                <option key={language.code} value={language.code}>
                  {language.name} ({language.code})
                </option>
              ))}
            </select>
          </label>
          <button
            className="swap"
            type="button"
            onClick={handleSwap}
            disabled={sourceLang === "auto"}
          >
            Swap
          </button>
          <label>
            To
            <select
              value={targetLang}
              onChange={(event) => setTargetLang(event.target.value)}
            >
              {languages.map((language) => (
                <option key={language.code} value={language.code}>
                  {language.name} ({language.code})
                </option>
              ))}
            </select>
          </label>
        </div>

        {detectionNote ? (
          <div className="detect-row" role="status" aria-live="polite">
            <span className="detect-pill">{detectionNote}</span>
          </div>
        ) : null}

        <div className="action-row">
          <button
            className="primary"
            type="button"
            onClick={handleTranslate}
            disabled={
              isBusy ||
              !inputText.trim() ||
              (!chunkingEnabled && inputTokenCount > inputTokenLimit)
            }
          >
            {isBusy ? "Streaming..." : "Translate"}
          </button>
          <button
            className="ghost"
            type="button"
            onClick={handleStop}
            disabled={!isBusy}
          >
            Stop
          </button>
          <div className="status">
            {error ? (
              <span className="error">{error}</span>
            ) : (
              <span className="muted">
                {chunkStatus ||
                  "First run can take a minute while the model boots."}
              </span>
            )}
          </div>
        </div>

        <div className="options-row">
          <label className="toggle">
            <input
              className="toggle-input"
              type="checkbox"
              checked={chunkingEnabled}
              onChange={(event) => setChunkingEnabled(event.target.checked)}
            />
            <span className="toggle-ui" aria-hidden="true" />
            <span className="toggle-text">
              Long text mode
              <span className="toggle-help">
                Splits long input into sentence-sized chunks, streams each
                translation, then merges the result.
              </span>
            </span>
          </label>
        </div>
      </section>

      <section className="panels">
        <div className="panel">
          <div className="panel-head">
            <span className="tag">{sourceTag || "src"}</span>
            <div className="panel-actions">
              <button
                className="ghost"
                type="button"
                onClick={() => setInputText("")}
                disabled={!inputText}
              >
                Clear
              </button>
            </div>
          </div>
          <textarea
            value={inputText}
            onChange={(event) => setInputText(event.target.value)}
            placeholder="Type or paste text to translate..."
          />
          <div className="panel-meta">
            <span className={tokenClass}>
              {inputTokenCount} / {inputTokenLimit} tokens
            </span>
            {inputWarning ? (
              <span className={warningClass}>{inputWarning}</span>
            ) : null}
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <span className="tag">{targetLang || "tgt"}</span>
            <div className="panel-actions">
              <button
                className="ghost"
                type="button"
                onClick={handleCopy}
                disabled={!outputText}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
          <textarea
            readOnly
            value={outputText}
            placeholder="Translation appears here..."
          />
        </div>
      </section>

    </div>
  );
}
