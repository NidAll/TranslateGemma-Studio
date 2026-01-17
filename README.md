# TranslateGemma Local

Local translation UI for `google/translategemma-4b-it` running on llama.cpp.

## What this does

- Starts a thin adapter API that forwards text translation requests to llama.cpp.
- If llama.cpp is not running, it auto-starts with:
  `llama-server -hf mradermacher/translategemma-4b-it-GGUF:Q6_K --jinja -c 0 --host 127.0.0.1 --port 8033 --flash-attn on`
- Serves a Next.js web UI on `http://127.0.0.1:3000`.

## Installation and setup

### Requirements

- Node.js 18+ and npm
- `llama.cpp` with `llama-server`
- A TranslateGemma GGUF model file
- Optional: fastText language ID model for auto detection

### 1) Get the model

Download a GGUF build of TranslateGemma from:
`https://huggingface.co/mradermacher/translategemma-4b-it-GGUF`

Choose a quantization that fits your VRAM (Q4, Q5, Q6, etc).

### 2) Install llama.cpp

If you want to know how to install it visit:
`https://github.com/ggml-org/llama.cpp?tab=readme-ov-file#quick-start`

### 3) Install dependencies

```bash
git clone https://github.com/NidAll/TranslateGemma-Studio
cd TranslateGemma-Studio
```

```bash
npm install
```

### 4) (Optional) Enable auto language detection

This app can auto-detect the source language using fastText.

Install fastText and download the model:

- Windows: `python -m pip install fasttext-wheel` and use `scripts/fasttext.cmd`.
- Linux: install the fastText CLI (package or build from source).
- Download `lid.176.bin` from `https://fasttext.cc/docs/en/language-identification.html`.
- Set `FASTTEXT_MODEL` to the full path of `lid.176.bin`.
- If the `fasttext` executable is not on PATH, set `FASTTEXT_CMD`.
  On Windows, `scripts/fasttext.cmd` is auto-detected if present.

### 5) Start the app

```bash
npm run dev
```

The UI will load while the model boots. The first translation may take a minute.

### Example environment settings

Windows (PowerShell):
```powershell
$env:LLAMA_SERVER_CMD = "C:\llama cpp\llama-server.exe"
$env:FASTTEXT_CMD = "C:\Translator\scripts\fasttext.cmd"
$env:FASTTEXT_MODEL = "C:\Translator\models\lid.176.bin"
```

Linux:
```bash
export LLAMA_SERVER_CMD=/path/to/llama-server
export FASTTEXT_CMD=fasttext
export FASTTEXT_MODEL=/path/to/lid.176.bin
```

### What is TranslateGemma (Gemma 3 Translate)?

TranslateGemma is a translation-focused variant of the Gemma 3 family released by
Google. It is optimized for text translation across 55 languages and is small
enough to run locally with the right quantization.

### Quick notes for llama.cpp model loading

By default the server starts with:
`llama-server -hf mradermacher/translategemma-4b-it-GGUF:Q6_K --jinja -c 0 --host 127.0.0.1 --port 8033 --flash-attn on`

If you want to load a local GGUF file instead, set `LLAMA_MODEL` to the local
path (or override `LLAMA_SERVER_ARGS`).

## UI notes

- Streaming is enabled by default for faster feedback.
- Light/dark theme toggle is in the header.
- The language list is a curated 55-language set in `shared/languages.js` and can be edited if needed.
- Source language supports `Auto detect` when fastText is configured.
- Input length is capped based on the 2K token context window to avoid truncated outputs.
- Long text mode splits large inputs into sentence-sized chunks, streams each chunk, and merges the results.
- Prompt mode defaults to plain text instructions for compatibility; set `LLAMA_PROMPT_MODE=structured` to use the model's structured template.

## Environment options

- `LLAMA_HOST` (default: `127.0.0.1`)
- `LLAMA_PORT` (default: `8033`)
- `LLAMA_MODEL` (default: `mradermacher/translategemma-4b-it-GGUF:Q6_K`)
- `LLAMA_SERVER_CMD` (default: `C:\llama cpp\llama-server.exe` on Windows if it exists, otherwise `llama-server`)
- `LLAMA_SERVER_ARGS` (optional override for all args)
- `LLAMA_SERVER_URL` (optional override for the full base URL)
- `PORT` (default: `3000`)
- `LLAMA_PROMPT_MODE` (default: `plain`, set to `structured` to send the TranslateGemma structured content payload)
- `NEXT_TELEMETRY_DISABLED` (default: `1` to avoid Next.js version checks in offline mode)
- `LLAMA_CONTEXT_TOKENS` (default: `2048`)
- `LLAMA_MAX_OUTPUT_TOKENS` (default: `512`)
- `LLAMA_PROMPT_OVERHEAD_TOKENS` (default: `120`)
- `FASTTEXT_CMD` (default: `fasttext`)
- `FASTTEXT_MODEL` (default: `models/lid.176.bin`)

## Translation contract

The adapter sends the TranslateGemma-specific chat template:
- `role: "user"`
- `content`: list of exactly one item
- item includes `type`, `source_lang_code`, `target_lang_code`, and `text`

## Image translation (not enabled yet)

The model supports image inputs, but the adapter and UI are text-only until
llama.cpp accepts the vision projector and image payloads end-to-end.
Once available, the adapter can pass `type: "image"` with a `url` payload.

## Known limits

- Text-only mode; image translation is not wired yet.
- 2K context window is enforced; long inputs must be chunked.
- Output cleanup strips model control tokens and common prefixes; if a case is missed, adjust `shared/sanitize.js`.
- Prompt mode defaults to `plain`; use `LLAMA_PROMPT_MODE=structured` if your llama.cpp build supports the structured template.
