param(
  [switch]$SkipNpmInstall
)

$ErrorActionPreference = "Stop"

Write-Host "== WebAgent z.ai bridge setup ==" -ForegroundColor Cyan

if (-not $SkipNpmInstall) {
  Write-Host "Installing npm dependencies..." -ForegroundColor Yellow
  cmd /c npm install
}

$companionPath = Join-Path $PSScriptRoot "..\resources\zai-bridge-companion\server.js"
$extensionPath = Join-Path $PSScriptRoot "..\resources\zai-browser-extension"
$resolvedCompanion = (Resolve-Path $companionPath).Path
$resolvedExtension = (Resolve-Path $extensionPath).Path

Write-Host ""
Write-Host "1) Load browser extension (Chrome/Edge):" -ForegroundColor Green
Write-Host "   - Open extensions page" -ForegroundColor Gray
Write-Host "   - Enable Developer mode" -ForegroundColor Gray
Write-Host "   - Click 'Load unpacked'" -ForegroundColor Gray
Write-Host "   - Select: $resolvedExtension" -ForegroundColor Gray

Write-Host ""
Write-Host "2) Start companion server:" -ForegroundColor Green
Write-Host "   cmd /c npm run bridge:companion" -ForegroundColor Gray

Write-Host ""
Write-Host "Companion entry file: $resolvedCompanion" -ForegroundColor DarkGray
Write-Host "After companion + browser extension are running, set VS Code setting webagentCode.transport.zai=bridge" -ForegroundColor Cyan

