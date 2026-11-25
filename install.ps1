<#
  Custom Badge by Kazu - instalador para Windows (Vencord o Equicord).
  No necesita Node.js ni Git: descarga una versión ya compilada (la compila GitHub automáticamente).

  Qué hace, paso a paso (puedes leerlo entero antes de ejecutarlo):
    1. Descarga el cliente ya compilado con el plugin incluido (release "latest" de este repositorio).
    2. Descarga el instalador oficial de Vencord / Equicord y lo usa para parchear tu Discord
       (cierra Discord un momento).
    3. Activa el plugin y vuelve a abrir Discord.

  Es seguro volver a ejecutarlo: sirve para actualizar el plugin o para reinstalarlo tras una actualización de Discord.
  Código fuente: https://github.com/joelbooris26-del/CustomBadgeByKazu
#>
param(
    [ValidateSet("", "Vencord", "Equicord")] [string]$Client = "",
    [ValidateSet("", "Stable", "Canary", "PTB")] [string]$Discord = "",
    [string]$InstallRoot = "$env:LOCALAPPDATA\CustomBadgeByKazu",
    [switch]$SkipInject,
    [switch]$Yes
)

$ErrorActionPreference = "Stop"
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }
$ProgressPreference = "SilentlyContinue"

$ReleaseBase = "https://github.com/joelbooris26-del/CustomBadgeByKazu/releases/download/latest"
$PluginName = "CustomBadgeByKazu"
$Folders = @{ Stable = "$env:LOCALAPPDATA\Discord"; Canary = "$env:LOCALAPPDATA\DiscordCanary"; PTB = "$env:LOCALAPPDATA\DiscordPTB" }
$Procs = @{ Stable = "Discord"; Canary = "DiscordCanary"; PTB = "DiscordPTB" }
$InstallerUrl = @{
    Vencord  = "https://github.com/Vencord/Installer/releases/latest/download/VencordInstallerCli.exe"
    Equicord = "https://github.com/Equicord/Equilotl/releases/latest/download/EquilotlCli.exe"
}

function Say($msg, $color = "Cyan") { Write-Host "`n>> $msg" -ForegroundColor $color }
function Fail($msg) { Write-Host "`nERROR: $msg" -ForegroundColor Red; if (-not $Yes) { Read-Host "Pulsa Intro para salir" }; exit 1 }

function Ask($title, $options) {
    Write-Host "`n$title" -ForegroundColor Yellow
    for ($i = 0; $i -lt $options.Count; $i++) { Write-Host ("  {0}) {1}" -f ($i + 1), $options[$i]) }
    while ($true) {
        $n = Read-Host "Elige un número"
        if ($n -match '^\d+$' -and [int]$n -ge 1 -and [int]$n -le $options.Count) { return $options[[int]$n - 1] }
    }
}

function Download($url, $dest) {
    try { Invoke-WebRequest $url -OutFile $dest -UseBasicParsing }
    catch { Fail "No se pudo descargar $url`n$($_.Exception.Message)" }
}

Write-Host "=== Custom Badge by Kazu: instalador ===" -ForegroundColor Green

if (-not $Client) { $Client = Ask "¿Qué cliente de Discord usas?" @("Vencord", "Equicord") }

if (-not $Discord) {
    $found = @($Folders.Keys | Where-Object { Test-Path $Folders[$_] } | Sort-Object)
    if ($found.Count -eq 0) { Fail "No encuentro Discord instalado en tu usuario." }
    $Discord = if ($found.Count -eq 1) { $found[0] } else { Ask "¿En qué Discord lo instalo?" $found }
}
$discordDir = $Folders[$Discord]
if (-not (Test-Path $discordDir)) { Fail "No encuentro Discord $Discord en $discordDir." }

Write-Host "`nSe va a instalar $Client + el plugin en Discord $Discord." -ForegroundColor Yellow
Write-Host "Discord se cerrará un momento. Tus ajustes de $Client no se borran."
if (-not $Yes -and (Read-Host "¿Continuar? (S/N)") -notmatch '^[sSyY]') { exit 0 }

# 1. Cliente ya compilado
$dir = Join-Path $InstallRoot $Client
New-Item -ItemType Directory -Force $dir | Out-Null
$zip = Join-Path $env:TEMP "$Client-dist.zip"
Say "Descargando $Client con el plugin incluido..."
Download "$ReleaseBase/$Client-dist.zip" $zip
if (Test-Path "$dir\dist") { Remove-Item "$dir\dist" -Recurse -Force }
Expand-Archive -Path $zip -DestinationPath $dir -Force
Remove-Item $zip -ErrorAction SilentlyContinue
if (-not (Test-Path "$dir\dist")) { Fail "El archivo descargado no tiene la carpeta esperada (dist)." }

# 2. Instalador oficial
$cliDir = Join-Path $dir "Installer"
New-Item -ItemType Directory -Force $cliDir | Out-Null
$cli = Join-Path $cliDir (Split-Path $InstallerUrl[$Client] -Leaf)
Say "Descargando el instalador oficial de $Client..."
Download $InstallerUrl[$Client] $cli

if ($SkipInject) { Say "Modo prueba: descargado, no se instala en Discord." "Green"; return }

# 3. Parchear Discord
Say "Cerrando Discord e instalando..."
Get-Process -Name $Procs[$Discord] -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep 2

if ($Client -eq "Vencord") {
    $env:VENCORD_USER_DATA_DIR = $dir
    $env:VENCORD_DEV_INSTALL = "1"
} else {
    $env:EQUICORD_USER_DATA_DIR = $dir
    $env:EQUICORD_DIRECTORY = Join-Path $dir "dist\desktop"
    $env:EQUICORD_DEV_INSTALL = "1"
}
$ErrorActionPreference = "Continue"
& $cli -install -location $discordDir
$code = $LASTEXITCODE
$ErrorActionPreference = "Stop"
Remove-Item Env:VENCORD_USER_DATA_DIR, Env:VENCORD_DEV_INSTALL, Env:EQUICORD_USER_DATA_DIR, Env:EQUICORD_DIRECTORY, Env:EQUICORD_DEV_INSTALL -ErrorAction SilentlyContinue
if ($code -ne 0) { Fail "El instalador de $Client falló (código $code)." }

# 4. Activar el plugin (sin romper tus ajustes: hace copia de seguridad)
Say "Activando el plugin..."
$settingsDir = Join-Path $env:APPDATA "$Client\settings"
New-Item -ItemType Directory -Force $settingsDir | Out-Null
$file = Join-Path $settingsDir "settings.json"
$utf8 = New-Object System.Text.UTF8Encoding($false)
$obj = $null
$skip = $false
if (Test-Path $file) {
    Copy-Item $file "$file.bak-custombadge" -Force
    try { $obj = [IO.File]::ReadAllText($file) | ConvertFrom-Json } catch { $skip = $true }
}
if ($skip) {
    Write-Host "No pude leer tus ajustes; actívalo a mano en Ajustes > Plugins." -ForegroundColor Yellow
} else {
    if (-not $obj) { $obj = [pscustomobject]@{} }
    if (-not $obj.PSObject.Properties["plugins"]) { $obj | Add-Member -NotePropertyName plugins -NotePropertyValue ([pscustomobject]@{}) }
    if ($obj.plugins.PSObject.Properties[$PluginName]) {
        $obj.plugins.$PluginName | Add-Member -NotePropertyName enabled -NotePropertyValue $true -Force
    } else {
        $obj.plugins | Add-Member -NotePropertyName $PluginName -NotePropertyValue ([pscustomobject]@{ enabled = $true })
    }
    [IO.File]::WriteAllText($file, (ConvertTo-Json -InputObject $obj -Depth 100), $utf8)
}

Say "Abriendo Discord..."
$update = Join-Path $discordDir "Update.exe"
if (Test-Path $update) { Start-Process $update -ArgumentList "--processStart", "$($Procs[$Discord]).exe" }

Write-Host "`n¡Listo! En Discord ve a Ajustes > Plugins > Custom Badge by Kazu." -ForegroundColor Green
Write-Host "Pulsa 'Iniciar sesión con Discord' y añade tus insignias."
Write-Host "Si Discord se actualiza y deja de verse, vuelve a ejecutar este instalador."
if (-not $Yes) { Read-Host "`nPulsa Intro para cerrar" }
