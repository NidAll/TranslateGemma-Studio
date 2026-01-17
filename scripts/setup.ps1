param(
  [string]$LlamaServerCmd = "",
  [switch]$EnableFastText
)

$ErrorActionPreference = "Stop"

function Write-Section {
  param([string]$Text)
  Write-Host ""
  Write-Host "== $Text =="
}

function Set-EnvValue {
  param(
    [string]$Key,
    [string]$Value,
    [string]$FilePath
  )

  if (-not $Value) {
    return
  }

  $lines = @()
  if (Test-Path $FilePath) {
    $lines = Get-Content -Path $FilePath
  }

  $lines = $lines | Where-Object { $_ -notmatch "^\s*$Key=" }
  $lines += "$Key=$Value"
  $lines | Set-Content -Path $FilePath -Encoding ASCII
}

function Resolve-LlamaServerCmd {
  param([string]$Candidate)

  if ($Candidate -and (Test-Path $Candidate)) {
    return $Candidate
  }

  $cmd = Get-Command "llama-server" -ErrorAction SilentlyContinue
  if ($cmd) {
    return $cmd.Source
  }

  return ""
}

function Get-VramGB {
  try {
    $adapters = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue
    if (-not $adapters) {
      return $null
    }
    $maxBytes = ($adapters | Where-Object { $_.AdapterRAM } | Measure-Object -Property AdapterRAM -Maximum).Maximum
    if (-not $maxBytes) {
      return $null
    }
    return [math]::Floor($maxBytes / 1GB)
  } catch {
    return $null
  }
}

function Select-Quantization {
  param(
    [int]$VramGB,
    [array]$Options
  )

  $available = [math]::Max(0, $VramGB - 1)
  $sorted = $Options | Sort-Object -Property MinVramGB -Descending
  foreach ($option in $sorted) {
    if ($available -ge $option.MinVramGB) {
      return $option
    }
  }

  return $sorted[-1]
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $scriptDir
Set-Location $root

Write-Section "TranslateGemma Studio setup"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js was not found. Install Node.js 18+ and try again."
  exit 1
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Host "npm was not found. Install Node.js 18+ and try again."
  exit 1
}

Write-Section "Installing npm dependencies"
npm install

$envFile = Join-Path $root ".env.local"
$modelsDir = Join-Path $root "models"
New-Item -ItemType Directory -Path $modelsDir -Force | Out-Null

Write-Section "llama.cpp check"
$resolvedLlama = Resolve-LlamaServerCmd $LlamaServerCmd
if (-not $resolvedLlama) {
  $prompt = Read-Host "llama-server not found. Enter full path or leave blank to skip"
  if ($prompt -and (Test-Path $prompt.Trim())) {
    $resolvedLlama = $prompt.Trim()
  }
}

if ($resolvedLlama) {
  Set-EnvValue -Key "LLAMA_SERVER_CMD" -Value $resolvedLlama -FilePath $envFile
} else {
  Write-Host "Warning: llama-server was not found. Install llama.cpp before running the app."
}

Write-Section "Flash attention"
Write-Host "Flash attention can speed up attention and lower memory use on supported GPUs."
Write-Host "Requires llama.cpp built with flash attention and a compatible CUDA GPU."
$flashChoice = Read-Host "Enable flash attention? (y/N)"
$flashValue = "off"
if ($flashChoice -match "^[Yy]") {
  $flashValue = "on"
}
Set-EnvValue -Key "LLAMA_FLASH_ATTN" -Value $flashValue -FilePath $envFile

Write-Section "Model download"
$existingModel = Read-Host "Optional: path to a local GGUF model (leave blank to download)"
if ($existingModel -and (Test-Path $existingModel.Trim())) {
  Set-EnvValue -Key "LLAMA_MODEL" -Value $existingModel.Trim() -FilePath $envFile
} else {
  $quantOptions = @(
    @{ Name = "Q8_0"; MinVramGB = 12; File = "translategemma-4b-it.Q8_0.gguf"; Tag = "Q8_0" },
    @{ Name = "Q6_K"; MinVramGB = 8; File = "translategemma-4b-it.Q6_K.gguf"; Tag = "Q6_K" },
    @{ Name = "Q5_K_M"; MinVramGB = 6; File = "translategemma-4b-it.Q5_K_M.gguf"; Tag = "Q5_K_M" },
    @{ Name = "Q4_K_M"; MinVramGB = 4; File = "translategemma-4b-it.Q4_K_M.gguf"; Tag = "Q4_K_M" }
  )

  $vramGB = Get-VramGB
  if (-not $vramGB) {
    $vramInput = Read-Host "Enter GPU VRAM in GB (leave blank to skip auto-select)"
    if ($vramInput -match "^\d+$") {
      $vramGB = [int]$vramInput
    }
  } else {
    Write-Host "Detected VRAM: $vramGB GB"
  }

  $selected = $null
  if ($vramGB) {
    $recommended = Select-Quantization -VramGB $vramGB -Options $quantOptions
    $confirm = Read-Host "Use recommended quantization $($recommended.Name)? (Y/n)"
    if ($confirm -notmatch "^[Nn]") {
      $selected = $recommended
    }
  }

  if (-not $selected) {
    Write-Host "Select a quantization:"
    for ($i = 0; $i -lt $quantOptions.Count; $i += 1) {
      $opt = $quantOptions[$i]
      Write-Host ("{0}) {1} (min VRAM ~{2} GB)" -f ($i + 1), $opt.Name, $opt.MinVramGB)
    }
    $choice = Read-Host "Enter choice number"
    if ($choice -match "^\d+$") {
      $index = [int]$choice - 1
      if ($index -ge 0 -and $index -lt $quantOptions.Count) {
        $selected = $quantOptions[$index]
      }
    }
  }

  if (-not $selected) {
    $selected = $quantOptions[-1]
  }

  if ($vramGB -and $selected.MinVramGB -gt ($vramGB - 1)) {
    Write-Host "Warning: selected quantization may exceed available VRAM."
  }

  $modelFile = Join-Path $modelsDir $selected.File
  if (-not (Test-Path $modelFile)) {
    Write-Host "Downloading $($selected.File)..."
    $url = "https://huggingface.co/mradermacher/translategemma-4b-it-GGUF/resolve/main/$($selected.File)"
    try {
      Invoke-WebRequest -Uri $url -OutFile $modelFile
    } catch {
      Write-Host "Download failed. You can download manually from Hugging Face."
    }
  }

  if (Test-Path $modelFile) {
    Set-EnvValue -Key "LLAMA_MODEL" -Value $modelFile -FilePath $envFile
  } else {
    $hfTag = "mradermacher/translategemma-4b-it-GGUF:$($selected.Tag)"
    Set-EnvValue -Key "LLAMA_MODEL" -Value $hfTag -FilePath $envFile
    Write-Host "Using Hugging Face tag: $hfTag"
  }
}

$useFastText = $EnableFastText
if (-not $EnableFastText) {
  $choice = Read-Host "Enable auto language detection with fastText? (y/N)"
  if ($choice -match "^[Yy]") {
    $useFastText = $true
  }
}

if ($useFastText) {
  if (Get-Command python -ErrorAction SilentlyContinue) {
    $install = Read-Host "Install fasttext-wheel with pip? (y/N)"
    if ($install -match "^[Yy]") {
      python -m pip install --upgrade fasttext-wheel
    }
  } else {
    Write-Host "Python not found. Install Python 3.10+ to use fasttext-wheel."
  }

  $fastTextModel = Join-Path $modelsDir "lid.176.bin"
  if (-not (Test-Path $fastTextModel)) {
    Write-Host "Downloading lid.176.bin..."
    Invoke-WebRequest -Uri "https://dl.fbaipublicfiles.com/fasttext/supervised-models/lid.176.bin" -OutFile $fastTextModel
  }

  $fastTextCmd = Join-Path $root "scripts\\fasttext.cmd"
  if (Test-Path $fastTextCmd) {
    Set-EnvValue -Key "FASTTEXT_CMD" -Value $fastTextCmd -FilePath $envFile
  } else {
    Write-Host "scripts\\fasttext.cmd not found. Set FASTTEXT_CMD manually."
  }
  Set-EnvValue -Key "FASTTEXT_MODEL" -Value $fastTextModel -FilePath $envFile
}

Write-Section "Setup complete"
Write-Host "Run: npm run dev"
