import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import languages from "../shared/languages.js";
import { normalizeLangCode } from "./lang.js";

const DEFAULT_FASTTEXT_CMD_WIN = path.join(
  process.cwd(),
  "scripts",
  "fasttext.cmd"
);
const FASTTEXT_CMD =
  process.env.FASTTEXT_CMD ||
  (process.platform === "win32" && fs.existsSync(DEFAULT_FASTTEXT_CMD_WIN)
    ? DEFAULT_FASTTEXT_CMD_WIN
    : "fasttext");
const DEFAULT_MODEL_PATH = path.join(process.cwd(), "models", "lid.176.bin");
const FASTTEXT_MODEL = process.env.FASTTEXT_MODEL || DEFAULT_MODEL_PATH;

const SUPPORTED_LANGS = new Map(
  languages.map((language) => [language.code.toLowerCase(), language.code])
);

const ALIAS_MAP = new Map([
  ["ar", "ar-SA"],
  ["es-mx", "es-MX"],
  ["iw", "he"],
  ["nb", "no"],
  ["nn", "no"],
  ["tl", "fil"],
  ["zh", "zh-CN"],
  ["zh-cn", "zh-CN"],
  ["zh-hans", "zh-CN"],
  ["zh-tw", "zh-TW"],
  ["zh-hant", "zh-TW"],
  ["pt-br", "pt-BR"]
]);

function resolveSupported(code) {
  if (!code) {
    return null;
  }

  const normalized = normalizeLangCode(code) || code.toLowerCase();
  const direct = SUPPORTED_LANGS.get(normalized.toLowerCase());
  if (direct) {
    return direct;
  }

  const alias = ALIAS_MAP.get(normalized.toLowerCase());
  if (alias) {
    return alias;
  }

  return null;
}

function parsePrediction(output) {
  if (!output) {
    return null;
  }
  const line = output.trim().split(/\r?\n/)[0];
  if (!line) {
    return null;
  }
  const [label, probRaw] = line.split(/\s+/);
  if (!label || !label.startsWith("__label__")) {
    return null;
  }
  const code = label.replace("__label__", "").trim();
  const prob = probRaw ? Number.parseFloat(probRaw) : null;
  return { code, prob: Number.isFinite(prob) ? prob : null };
}

function sanitizeCommand(value) {
  if (!value) {
    return value;
  }
  return String(value).trim().replace(/^"+|"+$/g, "");
}

function spawnFastText(command, args) {
  const cleaned = sanitizeCommand(command);
  const options = { stdio: ["pipe", "pipe", "pipe"] };
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(cleaned)) {
    const comspec = process.env.ComSpec || "cmd.exe";
    return spawn(comspec, ["/d", "/s", "/c", cleaned, ...args], options);
  }
  return spawn(cleaned, args, options);
}

export async function detectLanguage(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    throw new Error("Text is required for language detection.");
  }

  if (!fs.existsSync(FASTTEXT_MODEL)) {
    throw new Error(
      "FASTTEXT_MODEL not found. Download lid.176.bin and set FASTTEXT_MODEL."
    );
  }

  const input = trimmed.replace(/\s+/g, " ").slice(0, 20000);
  const args = ["predict-prob", FASTTEXT_MODEL, "-", "1"];

  return await new Promise((resolve, reject) => {
    const child = spawnFastText(FASTTEXT_CMD, args);
    let stdout = "";
    let stderr = "";

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("fastText detection timed out."));
    }, 8000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(
        new Error(`Failed to run fastText. ${err.message || String(err)}`)
      );
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(
          new Error(
            stderr.trim() ||
              `fastText exited with code ${code ?? "unknown"}.`
          )
        );
        return;
      }

      const prediction = parsePrediction(stdout);
      if (!prediction?.code) {
        reject(new Error("Unable to detect language."));
        return;
      }

      const resolved = resolveSupported(prediction.code);
      if (!resolved) {
        reject(
          new Error(
            `Detected language ${prediction.code} is not supported.`
          )
        );
        return;
      }

      resolve({
        code: resolved,
        probability: prediction.prob
      });
    });

    child.stdin.write(`${input}\n`);
    child.stdin.end();
  });
}
