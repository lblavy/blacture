#Requires -Version 7.4
[CmdletBinding()]
param([string]$GitleaksPath)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$repository = Split-Path -Parent $PSScriptRoot

if (-not $GitleaksPath) {
    $portable = Join-Path $repository 'work/tools/gitleaks-8.30.1/gitleaks.exe'
    if (Test-Path -LiteralPath $portable -PathType Leaf) {
        $GitleaksPath = $portable
    } else {
        $GitleaksPath = (Get-Command gitleaks -CommandType Application -ErrorAction SilentlyContinue).Source
    }
}
if (-not $GitleaksPath) {
    throw 'Gitleaks est requis. Consultez scripts/README.md pour le binaire portable.'
}
$GitleaksPath = (Get-Item -LiteralPath $GitleaksPath).FullName

$config = Join-Path $repository '.gitleaks.toml'
$scanOptions = @('--config', $config, '--redact=100', '--no-banner', '--no-color', '--ignore-gitleaks-allow', '--exit-code=2')

function Invoke-SecretScan([string]$Label, [string[]]$ScanArguments) {
    # Même avec la rédaction, un résultat peut contenir un chemin ou un message privé.
    & $GitleaksPath @ScanArguments @scanOptions *> $null
    switch ($LASTEXITCODE) {
        0 { return $false }
        2 { return $true }
        default { throw "Échec du contrôle Gitleaks ($Label, code $LASTEXITCODE)." }
    }
}

function Write-ScanStatus([string]$Label, [bool]$HasFindings) {
    $status = if ($HasFindings) { 'signalement à examiner' } else { 'aucun signalement' }
    Write-Host "$Label — $status"
}

Push-Location -LiteralPath $repository
try {
    $historyFindings = Invoke-SecretScan 'historique' @('git', '--log-opts=--all --reflog --full-history -m', '.')
    Write-ScanStatus 'Historique local' $historyFindings
    $stagedFindings = Invoke-SecretScan 'index' @('git', '--staged', '.')
    Write-ScanStatus 'Index' $stagedFindings
    $unstagedFindings = Invoke-SecretScan 'diff local' @('git', '--pre-commit', '.')
    Write-ScanStatus 'Modifications locales suivies' $unstagedFindings

    $untrackedOutput = git -c core.quotePath=false ls-files --others --exclude-standard -z
    if ($LASTEXITCODE -ne 0) {
        throw 'Impossible de lister les fichiers non suivis.'
    }
    $untrackedFindings = $false
    $untrackedFiles = ($untrackedOutput -join "`n").Split([char]0, [StringSplitOptions]::RemoveEmptyEntries)
    foreach ($relativePath in $untrackedFiles) {
        $entry = Get-Item -LiteralPath $relativePath
        if ($entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Entrée non suivie de type inattendu. Examiner les fichiers à inclure.'
        }
        if (Invoke-SecretScan 'fichiers non suivis' @('dir', $entry.FullName)) {
            $untrackedFindings = $true
        }
    }
    Write-ScanStatus 'Fichiers non suivis et non ignorés' $untrackedFindings

    if ($historyFindings -or $stagedFindings -or $unstagedFindings -or $untrackedFindings) {
        exit 2
    }
} finally {
    Pop-Location
}
