<#
  Custom Badge by Kazu - instalador para Windows (Vencord o Equicord).

  Qué hace, paso a paso (puedes leerlo entero antes de ejecutarlo):
    1. Comprueba que tienes Node.js y Git; si faltan, los instala con winget (el instalador oficial de Windows).
    2. Descarga el código de Vencord o Equicord y le añade el plugin.
    3. Compila y lo instala en tu Discord (cierra Discord un momento).
    4. Activa el plugin y vuelve a abrir Discord.

  Es seguro volver a ejecutarlo: sirve para actualizar el plugin o para reinstalarlo tras una actualización de Discord.
  Código fuente: https://github.com/joelbooris26-del/CustomBadgeByKazu
#>
param(
    [ValidateSet("", "Vencord", "Equicord")] [string]$Client = "",
    [ValidateSet("", "Stable", "Canary", "PTB")] [string]$Discord = "",
    [string]$InstallRoot = "$env:USERPROFILE\CustomBadgeByKazu-install",
    [switch]$SkipInject,
    [switch]$Yes
)

$ErrorActionPreference = "Continue"
$PluginRaw = "https://raw.githubusercontent.com/joelbooris26-del/CustomBadgeByKazu/main/plugin/customBadgeByKazu"
$PluginName = "CustomBadgeByKazu"
$Repos = @{ Vencord = "https://github.com/Vendicated/Vencord.git"; Equicord = "https://github.com/Equicord/Equicord.git" }
$Folders = @{ Stable = "$env:LOCALAPPDATA\Discord"; Canary = "$env:LOCALAPPDATA\DiscordCanary"; PTB = "$env:LOCALAPPDATA\DiscordPTB" }
$Procs = @{ Stable = "Discord"; Canary = "DiscordCanary"; PTB = "DiscordPTB" }

function Say($msg, $color = "Cyan") { Write-Host "`n>> $msg" -ForegroundColor $color }
function Fail($msg) { Write-Host "`nERROR: $msg" -ForegroundColor Red; Read-Host "Pulsa Intro para salir"; exit 1 }

function Ask($title, $options) {
    Write-Host "`n$title" -ForegroundColor Yellow
    for ($i = 0; $i -lt $options.Count; $i++) { Write-Host ("  {0}) {1}" -f ($i + 1), $options[$i]) }
    while ($true) {
        $n = Read-Host "Elige un número"
        if ($n -match '^\d+$' -and [int]$n -ge 1 -and [int]$n -le $options.Count) { return $options[[int]$n - 1] }
    }
}

function Update-Path {
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}

function Step($what, [scriptblock]$cmd) {
    & $cmd
    if ($LASTEXITCODE -ne 0) { Fail "Falló: $what (código $LASTEXITCODE)" }
}

function Ensure-Tool($exe, $wingetId, $label) {
    if (Get-Command $exe -ErrorAction SilentlyContinue) { return }
    Say "Instalando $label (hace falta una sola vez)..."
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Fail "No tienes $label ni winget. Instala $label a mano y vuelve a ejecutar esto."
    }
    winget install --id $wingetId -e --silent --accept-package-agreements --accept-source-agreements
    Update-Path
    if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) {
        Fail "$label se instaló pero Windows aún no lo ve. Cierra esta ventana y ejecuta el instalador otra vez."
    }
}

Write-Host "=== Custom Badge by Kazu: instalador ===" -ForegroundColor Green

if (-not $Client) { $Client = Ask "¿Qué cliente de Discord usas?" @("Vencord", "Equicord") }

if (-not $Discord) {
    $found = @($Folders.Keys | Where-Object { Test-Path $Folders[$_] } | Sort-Object)
    if ($found.Count -eq 0) { Fail "No encuentro Discord instalado en tu usuario." }
    $Discord = if ($found.Count -eq 1) { $found[0] } else { Ask "¿En qué Discord lo instalo?" $found }
}
if (-not (Test-Path $Folders[$Discord])) { Fail "No encuentro Discord $Discord en $($Folders[$Discord])." }

Write-Host "`nSe va a instalar $Client + el plugin en Discord $Discord." -ForegroundColor Yellow
Write-Host "Discord se cerrará un momento. Tus ajustes de $Client no se borran."
if (-not $Yes -and (Read-Host "¿Continuar? (S/N)") -notmatch '^[sSyY]') { exit 0 }
$repoUrl = $Repos[$Client]
$discordDir = $Folders[$Discord]

# 1. Herramientas
Ensure-Tool "git" "Git.Git" "Git"
Ensure-Tool "node" "OpenJS.NodeJS.LTS" "Node.js"
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Say "Instalando pnpm..."
    Step "instalar pnpm" { npm.cmd install -g pnpm }
    Update-Path
}

# 2. Código del cliente + plugin
New-Item -ItemType Directory -Force $InstallRoot | Out-Null
$dir = Join-Path $InstallRoot $Client
if (Test-Path "$dir\.git") {
    Say "Actualizando $Client..."
    Push-Location $dir
    Step "actualizar $Client" { git pull --ff-only }
    Pop-Location
} else {
    Say "Descargando $Client (puede tardar un minuto)..."
    Step "descargar $Client" { git clone --depth 1 $repoUrl $dir }
}

$pluginDir = Join-Path $dir "src\userplugins\customBadgeByKazu"
New-Item -ItemType Directory -Force $pluginDir | Out-Null
Say "Descargando el plugin..."
foreach ($f in "index.tsx", "native.ts") {
    try { Invoke-WebRequest "$PluginRaw/$f" -OutFile (Join-Path $pluginDir $f) -UseBasicParsing }
    catch { Fail "No se pudo descargar $f del repositorio del plugin: $($_.Exception.Message)" }
}

# 3. Compilar
Push-Location $dir
Say "Instalando dependencias..."
Step "instalar dependencias" { pnpm install --frozen-lockfile }
Say "Compilando..."
Step "compilar" { pnpm build }

if ($SkipInject) { Pop-Location; Say "Modo prueba: compilado, no se inyecta en Discord." "Green"; exit 0 }

# 4. Instalar en Discord y activar el plugin
Say "Cerrando Discord e instalando..."
Get-Process -Name $Procs[$Discord] -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep 2
Step "instalar en Discord" { node scripts/runInstaller.mjs -- -install -location $discordDir }
Pop-Location

Say "Activando el plugin..."
$settingsDir = Join-Path $env:APPDATA "$Client\settings"
New-Item -ItemType Directory -Force $settingsDir | Out-Null
$js = @'
const fs = require("fs");
const [file, name] = process.argv.slice(2);
let j = {};
try { j = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
j.plugins ??= {};
j.plugins[name] = { ...(j.plugins[name] || {}), enabled: true };
fs.writeFileSync(file, JSON.stringify(j, null, 4));
'@
$tmp = Join-Path $env:TEMP "cbk_enable.js"
Set-Content $tmp $js -Encoding UTF8
node $tmp (Join-Path $settingsDir "settings.json") $PluginName
Remove-Item $tmp -ErrorAction SilentlyContinue

Say "Abriendo Discord..."
$update = Join-Path $Folders[$Discord] "Update.exe"
$exeName = "$($Procs[$Discord]).exe"
if (Test-Path $update) { Start-Process $update -ArgumentList "--processStart", $exeName }

Write-Host "`n¡Listo! En Discord ve a Ajustes > Plugins > Custom Badge by Kazu." -ForegroundColor Green
Write-Host "Pulsa 'Iniciar sesión con Discord' y añade tus insignias."
Write-Host "Si Discord se actualiza y deja de verse, vuelve a ejecutar este instalador."
Read-Host "`nPulsa Intro para cerrar"
