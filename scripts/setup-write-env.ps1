$ErrorActionPreference = 'Stop'

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$envPath = Join-Path $projectRoot '.env'

if (-not (Test-Path $envPath)) {
    New-Item -ItemType File -Path $envPath | Out-Null
}

$lines = Get-Content $envPath -ErrorAction SilentlyContinue
if (-not $lines) {
    $lines = @()
}

function Set-Key {
    param(
        [string]$Key,
        [string]$Value
    )

    $prefix = $Key + '='
    $script:lines = @($script:lines | Where-Object { $_ -notmatch ('^' + [regex]::Escape($prefix)) })
    $script:lines += ($prefix + $Value)
}

Set-Key -Key 'AZURE_API_KEY' -Value $env:NEW_AZURE_API_KEY
Set-Key -Key 'AZURE_BASE_URL' -Value $env:NEW_AZURE_BASE_URL
Set-Key -Key 'AZURE_OPENAI_BASE_URL' -Value $env:NEW_AZURE_OPENAI_BASE_URL
Set-Key -Key 'PORT' -Value $env:NEW_PORT
Set-Key -Key 'PROXY_MODEL_PROFILE' -Value $env:NEW_PROXY_MODEL_PROFILE
Set-Key -Key 'PROXY_DEFAULT_PROFILE' -Value $env:NEW_PROXY_DEFAULT_PROFILE

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllLines($envPath, $lines, $utf8NoBom)
