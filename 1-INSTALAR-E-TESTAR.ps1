$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "PersonalizeWppConect")

Write-Host "Instalando dependencias sem baixar outro Chrome..." -ForegroundColor Cyan
$env:PUPPETEER_SKIP_DOWNLOAD = "true"
try {
    npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install falhou." }

    Write-Host "Executando teste completo..." -ForegroundColor Cyan
    npm test
    if ($LASTEXITCODE -ne 0) { throw "npm test falhou." }

    Write-Host "`nInstalacao e testes aprovados." -ForegroundColor Green
}
finally {
    Remove-Item Env:PUPPETEER_SKIP_DOWNLOAD -ErrorAction SilentlyContinue
}
