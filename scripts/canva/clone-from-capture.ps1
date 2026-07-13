param(
  [Parameter(Mandatory = $true)]
  [string]$DesignId,

  [string]$Root = ".tmp/canva-template-json"
)

$ErrorActionPreference = "Stop"

$repoRoot = Get-Location
$designDir = Join-Path $repoRoot (Join-Path $Root $DesignId)
$inputHtml = Join-Path $designDir "editor-page.full.html"
$domLayers = Join-Path $designDir "dom-layers.json"
$templateData = Join-Path $designDir "template-data.json"

if (-not (Test-Path -LiteralPath $designDir)) {
  throw "Design folder not found: $designDir"
}
if (-not (Test-Path -LiteralPath $inputHtml)) {
  throw "Missing capture file: $inputHtml"
}

Write-Host "Step 1/3: Extracting bootstrap/template/media JSON..."
node scripts/canva/clone-canva-template.mjs `
  --input $inputHtml `
  --output $designDir `
  --design-id $DesignId

if (Test-Path -LiteralPath $templateData) {
  Write-Host "Step 2/4: Building best pure-HTML clone (auto-scored)..."
  node scripts/canva/generate-best-pure-clone.mjs --design-id $DesignId
}

$candidateImageDirs = @(
  (Join-Path $designDir "assets/pages-exact-final"),
  (Join-Path $designDir "assets/pages-exact"),
  (Join-Path $designDir "assets/pages-exact2"),
  (Join-Path $designDir "assets/pages")
)

$imagesDir = $null
foreach ($dir in $candidateImageDirs) {
  if (Test-Path -LiteralPath $dir) {
    $hasImages = Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Extension -match '^\.(png|jpg|jpeg|webp)$' } |
      Select-Object -First 1
    if ($hasImages) {
      $imagesDir = $dir
      break
    }
  }
}

if (-not $imagesDir) {
  throw "No usable page image directory found under $designDir/assets."
}

if (Test-Path -LiteralPath $domLayers) {
  Write-Host "Step 3/4: Building exact visual clone + editable overlay HTML..."
  node scripts/canva/render-hybrid-editable-clone.mjs `
    --images $imagesDir `
    --dom $domLayers `
    --template-data $templateData `
    --output (Join-Path $designDir "template-clone-hybrid.html")
}
else {
  Write-Host "Step 3/4: dom-layers.json missing, building image-only exact clone..."
  node scripts/canva/render-image-clone-html.mjs `
    --images $imagesDir `
    --output (Join-Path $designDir "template-clone.html")
}

Write-Host "Step 4/4: Completed."
Write-Host "Design folder: $designDir"
Write-Host "Primary HTML:"
if (Test-Path -LiteralPath (Join-Path $designDir "template-clone-hybrid.html")) {
  Write-Host (Join-Path $designDir "template-clone-hybrid.html")
}
else {
  Write-Host (Join-Path $designDir "template-clone.html")
}
