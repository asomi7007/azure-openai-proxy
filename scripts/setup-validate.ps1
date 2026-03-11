$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$port = $env:NEW_PORT
if (-not ($port -match '^[0-9]+$')) {
    Write-Host '[ERROR] PORT must be numeric.'
    exit 1
}

$portNum = [int]$port
if ($portNum -lt 1 -or $portNum -gt 65535) {
    Write-Host '[ERROR] PORT must be between 1 and 65535.'
    exit 1
}

$baseUrl = $env:NEW_AZURE_BASE_URL
$openaiUrl = $env:NEW_AZURE_OPENAI_BASE_URL
if (-not [Uri]::IsWellFormedUriString($baseUrl, [UriKind]::Absolute)) {
    Write-Host '[ERROR] AZURE_BASE_URL must be a valid absolute URL.'
    exit 1
}

if (-not [Uri]::IsWellFormedUriString($openaiUrl, [UriKind]::Absolute)) {
    Write-Host '[ERROR] AZURE_OPENAI_BASE_URL must be a valid absolute URL.'
    exit 1
}

$listeners = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -eq $portNum }
if ($listeners) {
    Write-Host ('[ERROR] PORT ' + $portNum + ' is already in use.')
    exit 1
}

$excluded = netsh interface ipv4 show excludedportrange protocol=tcp 2>$null
foreach ($line in $excluded) {
    if ($line -match '^\s*(\d+)\s+(\d+)') {
        $start = [int]$matches[1]
        $end = [int]$matches[2]
        if ($portNum -ge $start -and $portNum -le $end) {
            Write-Host ('[ERROR] PORT ' + $portNum + ' falls within a Windows excluded port range (' + $start + '-' + $end + ').')
            exit 1
        }
    }
}

function Test-SetupUrl {
    param(
        [string]$Label,
        [string]$Url,
        [hashtable]$Headers
    )

    try {
        $resp = Invoke-WebRequest -Uri $Url -Headers $Headers -Method Head -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
        Write-Host ('[OK] ' + $Label + ' response check: ' + [int]$resp.StatusCode)
    } catch {
        $status = $null
        if ($_.Exception.Response) {
            $status = $_.Exception.Response.StatusCode.value__
        }

        if ($status) {
            Write-Host ('[WARN] ' + $Label + ' response code: ' + $status)
        } else {
            $errorType = $_.Exception.GetType().Name
            Write-Host ('[WARN] ' + $Label + ' connectivity check failed (' + $errorType + ').')
        }
    }
}

$headers = @{ 'api-key' = $env:NEW_AZURE_API_KEY }
Test-SetupUrl -Label 'AZURE_BASE_URL' -Url $baseUrl -Headers $headers
Test-SetupUrl -Label 'AZURE_OPENAI_BASE_URL' -Url $openaiUrl -Headers $headers

if ([string]::IsNullOrWhiteSpace($env:NEW_AZURE_API_KEY)) {
    Write-Host '[WARN] AZURE_API_KEY is empty, so API authentication validation is skipped.'
} else {
    Write-Host '[OK] API key value is present.'
}
