# AxloPOS print agent - one-step installer for a customer's Windows PC (D183).
#
# What it does, in order, and why each step exists:
#   1. Elevates itself (a Windows service can only be registered as admin).
#   2. Installs Node.js LTS through winget if `node` is missing - the agent is
#      plain Node, and this is the one prerequisite an installer can fix.
#   3. Copies dist\, scripts\ and package.json beside itself to InstallDir.
#   4. Writes agent.json from the API URL and the pairing token (asked for
#      interactively when not passed as parameters).
#   5. Fetches NSSM if it is not bundled and registers the agent as the
#      service "AxloPrintAgent": starts at boot, before anyone logs in,
#      restarts if it dies, logs to InstallDir\agent.log.
#   6. Stops the PC sleeping on mains power - a sleeping counter PC is a
#      silent kitchen printer.
#   7. Waits for the agent's first log line and tells you whether it paired.
#
# Usage - double-click install.cmd (it runs this with -ExecutionPolicy Bypass,
# because a zip downloaded from the internet is "not digitally signed" under the
# default RemoteSigned policy and PowerShell refuses it), or from a prompt:
#   .\install.ps1                                  # asks for the token
#   .\install.ps1 -Token pat_... -Name "Counter PC"  # unattended
#   .\install.ps1 -Uninstall                       # removes the service (keeps the folder)
#   .\install.ps1 -NoPause                         # for scripts: do not wait for Enter at the end
#
# Everything it prints is also in %TEMP%\axlo-print-agent-install.log, and the
# window waits for Enter before closing, so an error can actually be read.
#
# Re-running is safe: it re-copies the files, keeps an existing agent.json
# unless -Token is given, and re-registers the service. That is also how an
# agent is UPDATED - unzip the new release over the old one and run this.
[CmdletBinding()]
param(
  [string]$ApiUrl = "https://api.axlopos.com",
  [string]$Token,
  [string]$Name = $env:COMPUTERNAME,
  [string]$InstallDir = "C:\axlo-print-agent",
  [switch]$Uninstall,
  [switch]$NoPause
)

$ErrorActionPreference = "Stop"
$LogPath = Join-Path $env:TEMP "axlo-print-agent-install.log"
try { Start-Transcript -Path $LogPath -Append -ErrorAction SilentlyContinue | Out-Null } catch { }

function Finish($code) {
  try { Stop-Transcript -ErrorAction SilentlyContinue | Out-Null } catch { }
  if (-not $NoPause) {
    Write-Host ""
    Read-Host "Press Enter to close this window" | Out-Null
  }
  exit $code
}

# Any failure lands here: say what went wrong, where the log is, and WAIT, so
# the elevated window does not vanish with the answer in it.
trap {
  Write-Host ""
  Write-Host "FAILED: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Full log: $LogPath" -ForegroundColor Yellow
  Finish 1
}

# nssm.cc only speaks TLS 1.2+; Windows PowerShell 5.1 defaults to older.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$ServiceName = "AxloPrintAgent"
$NssmUrl = "https://nssm.cc/release/nssm-2.24.zip"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Step($text) { Write-Host ""; Write-Host "==> $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "    $text" -ForegroundColor Green }
function Warn($text) { Write-Host "    $text" -ForegroundColor Yellow }

# ── 1. admin ────────────────────────────────────────────────────────────────
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Step "Asking for administrator rights (needed to register the service)"
  # ($args is PowerShell's own automatic variable - never assign to it.)
  $argList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$($MyInvocation.MyCommand.Path)`"")
  foreach ($kv in $PSBoundParameters.GetEnumerator()) {
    if ($kv.Value -is [switch]) { if ($kv.Value) { $argList += "-$($kv.Key)" } }
    else { $argList += "-$($kv.Key)"; $argList += "`"$($kv.Value)`"" }
  }
  try {
    Start-Process powershell.exe -Verb RunAs -ArgumentList $argList -Wait
  } catch {
    throw "Administrator permission was refused. Right-click install.cmd and choose 'Run as administrator', then say Yes."
  }
  # The elevated window did the work and paused on its own; nothing to wait for here.
  $NoPause = $true
  Finish 0
}

function Find-Nssm {
  foreach ($candidate in @("$InstallDir\tools\nssm.exe", "$Here\tools\nssm.exe", "$Here\nssm.exe")) {
    if (Test-Path $candidate) { return $candidate }
  }
  $onPath = Get-Command nssm.exe -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  return $null
}

# ── uninstall ───────────────────────────────────────────────────────────────
if ($Uninstall) {
  Step "Removing the $ServiceName service"
  $nssm = Find-Nssm
  if (Get-Service $ServiceName -ErrorAction SilentlyContinue) {
    if ($nssm) { & $nssm stop $ServiceName confirm | Out-Null; & $nssm remove $ServiceName confirm | Out-Null }
    else { Stop-Service $ServiceName -Force -ErrorAction SilentlyContinue; sc.exe delete $ServiceName | Out-Null }
    Ok "Service removed. The folder $InstallDir and its agent.json are kept."
  } else { Ok "No service was installed." }
  Finish 0
}

# ── 2. node ─────────────────────────────────────────────────────────────────
Step "Checking Node.js"
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) {
  Warn "Node.js is not installed. Installing Node.js LTS with winget..."
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (-not $winget) {
    throw "winget is not available on this PC. Install Node.js LTS from https://nodejs.org/en/download and run this script again."
  }
  & winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements | Out-Null
  # winget updates PATH for new shells only; find node where it lands.
  $node = Get-Command "$env:ProgramFiles\nodejs\node.exe" -ErrorAction SilentlyContinue
  if (-not $node) { throw "Node.js was installed but node.exe was not found. Open a new window and run this script again." }
}
$nodeExe = $node.Source
$nodeVersion = (& $nodeExe --version)
if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 20) {
  throw "Node.js $nodeVersion is too old; the agent needs 20 or newer. Install Node.js LTS from https://nodejs.org/en/download."
}
Ok "Node.js $nodeVersion at $nodeExe"

# ── 3. files ────────────────────────────────────────────────────────────────
Step "Copying the agent to $InstallDir"
foreach ($required in @("dist\index.js", "scripts\windows-raw-printer.ps1", "package.json")) {
  if (-not (Test-Path "$Here\$required")) { throw "This folder is missing $required - unzip the whole release and run install.ps1 from inside it." }
}
New-Item -ItemType Directory -Force "$InstallDir\tools" | Out-Null
Copy-Item "$Here\dist" "$InstallDir\dist" -Recurse -Force
Copy-Item "$Here\scripts" "$InstallDir\scripts" -Recurse -Force
Copy-Item "$Here\package.json" "$InstallDir\package.json" -Force
if (Test-Path "$Here\README-CUSTOMER.md") { Copy-Item "$Here\README-CUSTOMER.md" "$InstallDir\README-CUSTOMER.md" -Force }
# Files from a downloaded zip carry the "mark of the web"; the agent runs the
# spooler helper with -ExecutionPolicy Bypass, but clear it anyway so nothing
# else on the machine ever refuses them.
Get-ChildItem $InstallDir -Recurse -File | Unblock-File -ErrorAction SilentlyContinue
Ok "Files in place"

# ── 4. agent.json ───────────────────────────────────────────────────────────
Step "Configuring"
$configPath = "$InstallDir\agent.json"
if (-not $Token -and (Test-Path $configPath)) {
  Ok "Keeping the existing agent.json (pass -Token to replace it)"
} else {
  if (-not $Token) {
    Write-Host ""
    Write-Host "    In the app: Settings -> Printing -> Print agent -> Pair a new agent." -ForegroundColor White
    Write-Host "    Copy the token it shows (it starts with pat_) and paste it here." -ForegroundColor White
    $Token = (Read-Host "    Pairing token").Trim()
  }
  if ($Token -notmatch '^pat_') { throw "That does not look like a pairing token (it starts with pat_)." }
  $config = [ordered]@{ apiUrl = $ApiUrl.TrimEnd('/'); token = $Token; name = $Name }
  ($config | ConvertTo-Json) | Set-Content -Path $configPath -Encoding UTF8
  Ok "agent.json written for '$Name' -> $ApiUrl"
}

# ── 5. service ──────────────────────────────────────────────────────────────
Step "Registering the $ServiceName service"
$nssm = Find-Nssm
if (-not $nssm) {
  Warn "Downloading NSSM (the service wrapper)..."
  $zip = "$env:TEMP\nssm.zip"
  Invoke-WebRequest -Uri $NssmUrl -OutFile $zip -UseBasicParsing
  $extract = "$env:TEMP\nssm-extract"
  if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $extract -Force
  $arch = if ([Environment]::Is64BitOperatingSystem) { "win64" } else { "win32" }
  $found = Get-ChildItem -Path $extract -Recurse -Filter nssm.exe | Where-Object { $_.FullName -match "\\$arch\\" } | Select-Object -First 1
  if (-not $found) { throw "nssm.exe was not found inside the download." }
  Copy-Item $found.FullName "$InstallDir\tools\nssm.exe" -Force
  $nssm = "$InstallDir\tools\nssm.exe"
}
if (Get-Service $ServiceName -ErrorAction SilentlyContinue) {
  & $nssm stop $ServiceName confirm | Out-Null
  & $nssm remove $ServiceName confirm | Out-Null
}
& $nssm install $ServiceName $nodeExe "`"$InstallDir\dist\index.js`"" | Out-Null
& $nssm set $ServiceName AppDirectory $InstallDir | Out-Null
& $nssm set $ServiceName DisplayName "AxloPOS print agent" | Out-Null
& $nssm set $ServiceName Description "Prints AxloPOS kitchen tickets and bills on this shop's printers." | Out-Null
& $nssm set $ServiceName Start SERVICE_AUTO_START | Out-Null
& $nssm set $ServiceName AppStdout "$InstallDir\agent.log" | Out-Null
& $nssm set $ServiceName AppStderr "$InstallDir\agent.log" | Out-Null
& $nssm set $ServiceName AppRotateFiles 1 | Out-Null
& $nssm set $ServiceName AppRotateBytes 5000000 | Out-Null
& $nssm set $ServiceName AppExit Default Restart | Out-Null
& $nssm set $ServiceName AppRestartDelay 5000 | Out-Null
& $nssm start $ServiceName | Out-Null
Ok "Service installed and started (auto-start at boot, restarts on failure)"

# ── 6. power ────────────────────────────────────────────────────────────────
Step "Stopping the PC from sleeping on mains power"
powercfg /change standby-timeout-ac 0 | Out-Null
powercfg /change hibernate-timeout-ac 0 | Out-Null
Ok "Sleep and hibernate on AC: never"

# ── 7. verify ───────────────────────────────────────────────────────────────
Step "Waiting for the agent to check in"
$log = "$InstallDir\agent.log"
$deadline = (Get-Date).AddSeconds(30)
$status = "unknown"
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  if (Test-Path $log) {
    $tail = Get-Content $log -Tail 20 -ErrorAction SilentlyContinue
    if ($tail -match "HTTP 401") { $status = "rejected"; break }
    if ($tail -match "discovery:") { $status = "ok"; break }
    if ($tail -match "starting v") { $status = "started" }
  }
}
switch ($status) {
  "ok"       { Ok "The agent is online and has scanned for printers. Check Settings -> Printing: it should show Online." }
  "started"  { Ok "The agent started. Give it a minute, then check Settings -> Printing for Online." }
  "rejected" { Warn "The API rejected the token (HTTP 401). Pair a new agent in the app and run: .\install.ps1 -Token pat_..." }
  default    { Warn "No log line yet. Look at $log and Get-Service $ServiceName." }
}
Write-Host ""
Write-Host "Done. Agent log: $log" -ForegroundColor White
Write-Host "Manage: $InstallDir\tools\nssm.exe start|stop|restart $ServiceName   Remove: install.cmd -Uninstall" -ForegroundColor White
Finish 0
