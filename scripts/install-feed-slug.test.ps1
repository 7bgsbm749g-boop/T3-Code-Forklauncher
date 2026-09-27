$ErrorActionPreference = "Stop"
$installer = Join-Path $PSScriptRoot "install.ps1"
$powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
$testHome = Join-Path $env:TEMP "t3-feed-slug-fixture"
$env:T3CODE_HOME = $testHome
$env:T3CODE_VERSION = "1.2.3"
$env:T3CODE_RELEASE_BASE_URL = "https://mirror.example/releases/"

function Invoke-Installer([string] $repository) {
  $env:T3CODE_RELEASE_REPOSITORY = $repository
  $env:T3CODE_INSTALL_VALIDATE_ONLY = "1"
  & $powershell -NoProfile -ExecutionPolicy Bypass -File $installer 2>&1
  return $LASTEXITCODE
}

$valid = Invoke-Installer "  owner/repo..mirror  "
$validData = $valid[0] | ConvertFrom-Json
if (
  $valid[-1] -ne 0 -or
  $validData.repository -ne "owner/repo..mirror" -or
  $validData.targetDir -ne (Join-Path $testHome "runtime\versions\.feeds\owner\repo..mirror\1.2.3") -or
  $validData.marker -ne "1.2.3`nowner/repo..mirror`nhttps://mirror.example/releases"
) {
  throw "PowerShell bootstrap did not trim and preserve a valid GitHub slug: $valid"
}
$invalid = Invoke-Installer "../repo"
if ($invalid[-1] -eq 0 -or ($invalid[0] -join "") -notmatch "GitHub owner/repository slug") {
  throw "PowerShell bootstrap accepted a whole dot segment: $invalid"
}
Remove-Item Env:T3CODE_RELEASE_REPOSITORY -ErrorAction SilentlyContinue
Remove-Item Env:T3CODE_INSTALL_VALIDATE_ONLY -ErrorAction SilentlyContinue
Remove-Item Env:T3CODE_HOME -ErrorAction SilentlyContinue
Remove-Item Env:T3CODE_VERSION -ErrorAction SilentlyContinue
Remove-Item Env:T3CODE_RELEASE_BASE_URL -ErrorAction SilentlyContinue
Write-Output "PowerShell feed slug fixtures passed."
