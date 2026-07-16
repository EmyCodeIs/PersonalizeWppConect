$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "PersonalizeWppConect")
Write-Host "Use somente depois de revisar a auditoria." -ForegroundColor Yellow
$confirmacao = Read-Host "Digite MIGRAR para transferir Aninha->Ana, Carlos->C. Eduardo e duplicatas de Adriano"
if ($confirmacao -cne "MIGRAR") {
    Write-Host "Cancelado. Nenhuma alteracao realizada." -ForegroundColor Yellow
    exit 0
}
npm run labels:sellers:migrate
if ($LASTEXITCODE -ne 0) { throw "A migracao falhou ou foi cancelada com seguranca." }
