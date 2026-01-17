#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

section() {
  echo ""
  echo "== $1 =="
}

set_env() {
  local key="$1"
  local value="$2"
  local file="$3"
  if [ -z "$value" ]; then
    return
  fi
  if [ -f "$file" ]; then
    grep -v "^${key}=" "$file" > "${file}.tmp" || true
    mv "${file}.tmp" "$file"
  fi
  printf '%s=%s\n' "$key" "$value" >> "$file"
}

resolve_llama_server() {
  local candidate="$1"
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    echo "$candidate"
    return
  fi
  if command -v llama-server >/dev/null 2>&1; then
    command -v llama-server
    return
  fi
  echo ""
}

detect_vram_gb() {
  if command -v nvidia-smi >/dev/null 2>&1; then
    local max_mb
    max_mb="$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | sort -nr | head -n1 | tr -d '\r')"
    if [ -n "$max_mb" ]; then
      echo $(( (max_mb + 1023) / 1024 ))
      return
    fi
  fi
  echo ""
}

select_quant_index() {
  local vram="$1"
  local available=$(( vram - 1 ))
  if [ "$available" -lt 0 ]; then
    available=0
  fi
  for i in "${!QUANT_NAMES[@]}"; do
    if [ "$available" -ge "${QUANT_MIN_VRAM[$i]}" ]; then
      echo "$i"
      return
    fi
  done
  echo "$(( ${#QUANT_NAMES[@]} - 1 ))"
}

section "TranslateGemma Studio setup"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Install Node.js 18+ and try again."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm was not found. Install Node.js 18+ and try again."
  exit 1
fi

section "Installing npm dependencies"
npm install

ENV_FILE="$ROOT_DIR/.env.local"
MODELS_DIR="$ROOT_DIR/models"
mkdir -p "$MODELS_DIR"

section "llama.cpp check"
read -r -p "Optional: path to llama-server (leave blank to skip): " LLAMA_SERVER_CMD
RESOLVED_LLAMA="$(resolve_llama_server "$LLAMA_SERVER_CMD")"
if [ -n "$RESOLVED_LLAMA" ]; then
  set_env "LLAMA_SERVER_CMD" "$RESOLVED_LLAMA" "$ENV_FILE"
else
  echo "Warning: llama-server was not found. Install llama.cpp before running the app."
fi

section "Flash attention"
echo "Flash attention can speed up attention and lower memory use on supported GPUs."
echo "Requires llama.cpp built with flash attention and a compatible CUDA GPU."
read -r -p "Enable flash attention? [y/N] " FLASH_CHOICE
FLASH_VALUE="off"
if [[ "$FLASH_CHOICE" =~ ^[Yy]$ ]]; then
  FLASH_VALUE="on"
fi
set_env "LLAMA_FLASH_ATTN" "$FLASH_VALUE" "$ENV_FILE"

section "Model download"
read -r -p "Optional: path to a local GGUF model (leave blank to download): " LOCAL_MODEL
if [ -n "$LOCAL_MODEL" ] && [ -f "$LOCAL_MODEL" ]; then
  set_env "LLAMA_MODEL" "$LOCAL_MODEL" "$ENV_FILE"
else
  QUANT_NAMES=("Q8_0" "Q6_K" "Q5_K_M" "Q4_K_M")
  QUANT_MIN_VRAM=(12 8 6 4)
  QUANT_FILES=("translategemma-4b-it.Q8_0.gguf" "translategemma-4b-it.Q6_K.gguf" "translategemma-4b-it.Q5_K_M.gguf" "translategemma-4b-it.Q4_K_M.gguf")

  VRAM_GB="$(detect_vram_gb)"
  if [ -n "$VRAM_GB" ]; then
    echo "Detected VRAM: ${VRAM_GB} GB"
  else
    read -r -p "Enter GPU VRAM in GB (leave blank to skip auto-select): " VRAM_GB
  fi

  SELECTED_INDEX=""
  if [[ "$VRAM_GB" =~ ^[0-9]+$ ]]; then
    RECOMMENDED_INDEX="$(select_quant_index "$VRAM_GB")"
    RECOMMENDED_NAME="${QUANT_NAMES[$RECOMMENDED_INDEX]}"
    read -r -p "Use recommended quantization ${RECOMMENDED_NAME}? [Y/n] " USE_RECOMMENDED
    if [[ ! "$USE_RECOMMENDED" =~ ^[Nn]$ ]]; then
      SELECTED_INDEX="$RECOMMENDED_INDEX"
    fi
  fi

  if [ -z "$SELECTED_INDEX" ]; then
    echo "Select a quantization:"
    for i in "${!QUANT_NAMES[@]}"; do
      echo "$((i + 1))) ${QUANT_NAMES[$i]} (min VRAM ~${QUANT_MIN_VRAM[$i]} GB)"
    done
    read -r -p "Enter choice number: " CHOICE
    if [[ "$CHOICE" =~ ^[0-9]+$ ]] && [ "$CHOICE" -ge 1 ] && [ "$CHOICE" -le "${#QUANT_NAMES[@]}" ]; then
      SELECTED_INDEX=$((CHOICE - 1))
    else
      SELECTED_INDEX=$((${#QUANT_NAMES[@]} - 1))
    fi
  fi

  if [[ "$VRAM_GB" =~ ^[0-9]+$ ]]; then
    REQUIRED="${QUANT_MIN_VRAM[$SELECTED_INDEX]}"
    if [ "$REQUIRED" -gt "$((VRAM_GB - 1))" ]; then
      echo "Warning: selected quantization may exceed available VRAM."
    fi
  fi

  MODEL_FILE="${QUANT_FILES[$SELECTED_INDEX]}"
  MODEL_PATH="$MODELS_DIR/$MODEL_FILE"
  if [ ! -f "$MODEL_PATH" ]; then
    echo "Downloading $MODEL_FILE..."
    if command -v curl >/dev/null 2>&1; then
      curl -L -o "$MODEL_PATH" "https://huggingface.co/mradermacher/translategemma-4b-it-GGUF/resolve/main/$MODEL_FILE"
    elif command -v wget >/dev/null 2>&1; then
      wget -O "$MODEL_PATH" "https://huggingface.co/mradermacher/translategemma-4b-it-GGUF/resolve/main/$MODEL_FILE"
    else
      echo "curl or wget is required to download the model."
      exit 1
    fi
  fi

  if [ -f "$MODEL_PATH" ]; then
    set_env "LLAMA_MODEL" "$MODEL_PATH" "$ENV_FILE"
  else
    HF_TAG="mradermacher/translategemma-4b-it-GGUF:${QUANT_NAMES[$SELECTED_INDEX]}"
    set_env "LLAMA_MODEL" "$HF_TAG" "$ENV_FILE"
    echo "Using Hugging Face tag: $HF_TAG"
  fi
fi

read -r -p "Enable auto language detection with fastText? [y/N] " ENABLE_FASTTEXT
if [[ "$ENABLE_FASTTEXT" =~ ^[Yy]$ ]]; then
  if ! command -v fasttext >/dev/null 2>&1; then
    echo "fasttext CLI not found on PATH. Install it or set FASTTEXT_CMD later."
  else
    set_env "FASTTEXT_CMD" "fasttext" "$ENV_FILE"
  fi

  FASTTEXT_MODEL="$MODELS_DIR/lid.176.bin"
  if [ ! -f "$FASTTEXT_MODEL" ]; then
    echo "Downloading lid.176.bin..."
    if command -v curl >/dev/null 2>&1; then
      curl -L -o "$FASTTEXT_MODEL" "https://dl.fbaipublicfiles.com/fasttext/supervised-models/lid.176.bin"
    elif command -v wget >/dev/null 2>&1; then
      wget -O "$FASTTEXT_MODEL" "https://dl.fbaipublicfiles.com/fasttext/supervised-models/lid.176.bin"
    else
      echo "curl or wget is required to download lid.176.bin."
      exit 1
    fi
  fi

  set_env "FASTTEXT_MODEL" "$FASTTEXT_MODEL" "$ENV_FILE"
fi

section "Setup complete"
echo "Run: npm run dev"
