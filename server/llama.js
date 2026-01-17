import { spawn } from "child_process";
import fs from "fs";
import path from "path";

const LLAMA_HOST = process.env.LLAMA_HOST || "127.0.0.1";
const LLAMA_PORT = process.env.LLAMA_PORT || "8033";
const LLAMA_MODEL =
  process.env.LLAMA_MODEL || "mradermacher/translategemma-4b-it-GGUF:Q6_K";
const DEFAULT_LLAMA_PATH_WIN = path.join("C:\\", "llama cpp", "llama-server.exe");
const LLAMA_SERVER_CMD =
  process.env.LLAMA_SERVER_CMD ||
  (process.platform === "win32" && fs.existsSync(DEFAULT_LLAMA_PATH_WIN)
    ? DEFAULT_LLAMA_PATH_WIN
    : "llama-server");

export const LLAMA_SERVER_URL =
  process.env.LLAMA_SERVER_URL || `http://${LLAMA_HOST}:${LLAMA_PORT}`;

const DEFAULT_ARGS = [
  "-hf",
  LLAMA_MODEL,
  "--jinja",
  "-c",
  "0",
  "--host",
  LLAMA_HOST,
  "--port",
  LLAMA_PORT,
  "--flash-attn",
  "on"
];

let llamaProcess = null;
let ensurePromise = null;

function splitArgs(input) {
  const matches = input.match(/(?:[^\s"]+|"[^"]*")+/g);
  if (!matches) {
    return [];
  }
  return matches.map((value) => value.replace(/^"|"$/g, ""));
}

function getArgs() {
  if (process.env.LLAMA_SERVER_ARGS) {
    return splitArgs(process.env.LLAMA_SERVER_ARGS);
  }
  return DEFAULT_ARGS;
}

async function isLlamaUp() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetch(`${LLAMA_SERVER_URL}/v1/models`, {
      signal: controller.signal
    });
    return response.ok;
  } catch (err) {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForLlamaReady() {
  const timeoutMs = 120000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isLlamaUp()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

export async function ensureLlamaServer() {
  if (await isLlamaUp()) {
    return;
  }

  if (!ensurePromise) {
    ensurePromise = (async () => {
      if (!(await isLlamaUp())) {
        llamaProcess = spawn(LLAMA_SERVER_CMD, getArgs(), {
          stdio: "inherit"
        });

        llamaProcess.on("exit", () => {
          llamaProcess = null;
        });
      }

      const ready = await waitForLlamaReady();
      if (!ready) {
        throw new Error("Timed out waiting for llama-server to start.");
      }
    })().finally(() => {
      ensurePromise = null;
    });
  }

  await ensurePromise;
}
