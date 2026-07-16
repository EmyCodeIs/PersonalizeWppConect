$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "PersonalizeWppConect")
Write-Host "O npm start deve estar fechado. Esta etapa nao altera etiquetas." -ForegroundColor Yellow
npm run labels:sellers:audit
if ($LASTEXITCODE -ne 0) { throw "A auditoria falhou ou a sincronizacao nao terminou." }
