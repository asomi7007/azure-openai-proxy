param(
  [ValidateSet('toggle', 'status', 'local', 'original', 'ensure-local', 'current-url', 'help')]
  [string]$Mode = 'toggle',
  [string]$SettingsPath = (Join-Path $env:USERPROFILE '.claude\settings.json'),
  [string]$StatePath = (Join-Path $env:USERPROFILE '.claude\claudeproxy-state.json'),
  [string]$LocalProxyUrl = 'http://localhost:8081'
)

$ErrorActionPreference = 'Stop'

function Get-SettingsObject {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    return [pscustomobject]@{}
  }

  $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
  if ([string]::IsNullOrWhiteSpace($raw)) {
    return [pscustomobject]@{}
  }

  return $raw | ConvertFrom-Json
}

function Ensure-ParentDirectory {
  param([string]$Path)

  $parent = Split-Path -Parent $Path
  if ($parent -and -not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
}

function Get-OrCreate-EnvObject {
  param(
    [Parameter(Mandatory = $true)]
    [psobject]$Settings
  )

  if (-not $Settings.PSObject.Properties['env']) {
    $envObject = [pscustomobject]@{}
    $Settings | Add-Member -NotePropertyName 'env' -NotePropertyValue $envObject
    return $envObject
  }

  if ($null -eq $Settings.env) {
    $Settings.PSObject.Properties.Remove('env')
    $envObject = [pscustomobject]@{}
    $Settings | Add-Member -NotePropertyName 'env' -NotePropertyValue $envObject
    return $envObject
  }

  return $Settings.env
}

function Remove-EmptyEnvObject {
  param(
    [Parameter(Mandatory = $true)]
    [psobject]$Settings
  )

  if (-not $Settings.PSObject.Properties['env']) {
    return
  }

  $envObject = $Settings.env
  if ($null -eq $envObject) {
    $Settings.PSObject.Properties.Remove('env')
    return
  }

  $propCount = @($envObject.PSObject.Properties).Count
  if ($propCount -eq 0) {
    $Settings.PSObject.Properties.Remove('env')
  }
}

function Backup-SettingsFile {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    return $null
  }

  $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backupPath = "$Path.bak-claudeproxy-$timestamp"
  Copy-Item -LiteralPath $Path -Destination $backupPath -Force
  return $backupPath
}

function Save-JsonFile {
  param(
    [Parameter(Mandatory = $true)]
    [psobject]$Object,
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  Ensure-ParentDirectory -Path $Path
  $json = $Object | ConvertTo-Json -Depth 100
  [System.IO.File]::WriteAllText($Path, $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
}

function Get-CurrentUrl {
  param([psobject]$Settings)

  if (-not $Settings) { return $null }
  if (-not $Settings.PSObject.Properties['env']) { return $null }
  if ($null -eq $Settings.env) { return $null }
  if (-not $Settings.env.PSObject.Properties['ANTHROPIC_BASE_URL']) { return $null }

  $value = $Settings.env.ANTHROPIC_BASE_URL
  if ([string]::IsNullOrWhiteSpace([string]$value)) { return $null }
  return [string]$value
}

function Test-IsLocalProxyUrl {
  param(
    [AllowNull()]
    [string]$Url,
    [string]$CanonicalUrl
  )

  if ([string]::IsNullOrWhiteSpace($Url)) {
    return $false
  }

  return $Url -match '^https?://(localhost|127\.0\.0\.1):8081(/anthropic)?/?$'
}

function Get-StateInfo {
  param(
    [AllowNull()]
    [string]$CurrentUrl,
    [string]$CanonicalUrl
  )

  if (Test-IsLocalProxyUrl -Url $CurrentUrl -CanonicalUrl $CanonicalUrl) {
    return 'LOCAL_PROXY'
  }

  if ([string]::IsNullOrWhiteSpace($CurrentUrl)) {
    return 'ORIGINAL'
  }

  return 'CUSTOM'
}

function Save-RestoreState {
  param(
    [string]$Path,
    [AllowNull()]
    [string]$CurrentUrl
  )

  $state = [pscustomobject]@{
    hadAnthropicBaseUrl = -not [string]::IsNullOrWhiteSpace($CurrentUrl)
    anthropicBaseUrl    = $CurrentUrl
    savedAt             = (Get-Date).ToString('s')
  }

  Save-JsonFile -Object $state -Path $Path
}

function Load-RestoreState {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    return $null
  }

  $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
  if ([string]::IsNullOrWhiteSpace($raw)) {
    return $null
  }

  return $raw | ConvertFrom-Json
}

function Set-LocalProxy {
  $settings = Get-SettingsObject -Path $SettingsPath
  $currentUrl = Get-CurrentUrl -Settings $settings

  if (Test-IsLocalProxyUrl -Url $currentUrl -CanonicalUrl $LocalProxyUrl) {
    Write-Output "Claude Code is already using the local proxy: $currentUrl"
    return
  }

  Save-RestoreState -Path $StatePath -CurrentUrl $currentUrl
  $backupPath = Backup-SettingsFile -Path $SettingsPath

  $envObject = Get-OrCreate-EnvObject -Settings $settings
  if ($envObject.PSObject.Properties['ANTHROPIC_BASE_URL']) {
    $envObject.ANTHROPIC_BASE_URL = $LocalProxyUrl
  } else {
    $envObject | Add-Member -NotePropertyName 'ANTHROPIC_BASE_URL' -NotePropertyValue $LocalProxyUrl
  }

  Save-JsonFile -Object $settings -Path $SettingsPath

  if ($backupPath) {
    Write-Output "Claude Code was switched to the local proxy: $LocalProxyUrl"
    Write-Output "Backup: $backupPath"
  } else {
    Write-Output "Created a new Claude Code settings file and pointed it to the local proxy: $LocalProxyUrl"
  }
}

function Set-OriginalConfig {
  $settings = Get-SettingsObject -Path $SettingsPath
  $currentUrl = Get-CurrentUrl -Settings $settings
  $state = Load-RestoreState -Path $StatePath

  if (-not (Test-IsLocalProxyUrl -Url $currentUrl -CanonicalUrl $LocalProxyUrl) -and -not $state) {
    Write-Output 'Claude Code is already using the original setting.'
    return
  }

  $backupPath = Backup-SettingsFile -Path $SettingsPath
  $envObject = Get-OrCreate-EnvObject -Settings $settings

  if ($state -and $state.hadAnthropicBaseUrl -and -not [string]::IsNullOrWhiteSpace([string]$state.anthropicBaseUrl)) {
    if ($envObject.PSObject.Properties['ANTHROPIC_BASE_URL']) {
      $envObject.ANTHROPIC_BASE_URL = [string]$state.anthropicBaseUrl
    } else {
      $envObject | Add-Member -NotePropertyName 'ANTHROPIC_BASE_URL' -NotePropertyValue ([string]$state.anthropicBaseUrl)
    }
    $restored = [string]$state.anthropicBaseUrl
  } else {
    if ($envObject.PSObject.Properties['ANTHROPIC_BASE_URL']) {
      $envObject.PSObject.Properties.Remove('ANTHROPIC_BASE_URL')
    }
    Remove-EmptyEnvObject -Settings $settings
    $restored = $null
  }

  Save-JsonFile -Object $settings -Path $SettingsPath

  if (Test-Path -LiteralPath $StatePath) {
    Remove-Item -LiteralPath $StatePath -Force
  }

  if ($restored) {
    Write-Output "Claude Code was restored to the original setting: $restored"
  } else {
    Write-Output 'Claude Code was restored to the original setting: removed ANTHROPIC_BASE_URL'
  }

  if ($backupPath) {
    Write-Output "Backup: $backupPath"
  }
}

switch ($Mode) {
  'status' {
    $settings = Get-SettingsObject -Path $SettingsPath
    Write-Output (Get-StateInfo -CurrentUrl (Get-CurrentUrl -Settings $settings) -CanonicalUrl $LocalProxyUrl)
  }
  'current-url' {
    $settings = Get-SettingsObject -Path $SettingsPath
    $currentUrl = Get-CurrentUrl -Settings $settings
    if ($currentUrl) {
      Write-Output $currentUrl
    }
  }
  'local' {
    Set-LocalProxy
  }
  'ensure-local' {
    $settings = Get-SettingsObject -Path $SettingsPath
    $currentUrl = Get-CurrentUrl -Settings $settings
    if (Test-IsLocalProxyUrl -Url $currentUrl -CanonicalUrl $LocalProxyUrl) {
      Write-Output "Claude Code is already using the local proxy: $currentUrl"
    } else {
      Set-LocalProxy
    }
  }
  'original' {
    Set-OriginalConfig
  }
  'help' {
    Write-Output 'Usage: claudeproxy.bat [status|local|original|toggle]'
  }
  default {
    $settings = Get-SettingsObject -Path $SettingsPath
    $currentUrl = Get-CurrentUrl -Settings $settings
    if (Test-IsLocalProxyUrl -Url $currentUrl -CanonicalUrl $LocalProxyUrl) {
      Set-OriginalConfig
    } else {
      Set-LocalProxy
    }
  }
}
