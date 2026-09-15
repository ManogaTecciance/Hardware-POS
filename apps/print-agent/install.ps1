# AxloPOS print agent - one-step installer for a customer's Windows PC (D183).
#
# What it does, in order, and why each step exists:
#   1. Elevates itself (a Windows service can only be registered as admin).
#   2. Finds Node.js (installs LTS through winget if missing) and COPIES the
#      real node.exe into InstallDir\tools. The service runs that copy: a
#      node found through nvm-for-Windows (C:\nvm4w\nodejs) is a junction into
#      the user's profile that a LocalSystem service cannot follow - the first
#      customer install died on exactly that, with NSSM reporting
#      SERVICE_PAUSED and an empty log.
#   3. Copies dist\, scripts\ and package.json beside itself to InstallDir.
#   4. Asks for the API address and the pairing token (unless passed as
#      parameters) and writes agent.json. The address is asked because the
#      token is only valid on the API it was paired on, and the app shows
#      which one that is.
#   5. Fetches NSSM if it is not bundled and registers the agent as the
#      service "AxloPrintAgent": starts at boot, before anyone logs in,
#      restarts if it dies, logs to InstallDir\agent.log.
#   6. Stops the PC sleeping on mains power - a sleeping counter PC is a
#      silent kitchen printer.
#   7. Checks that the service is actually RUNNING, then reads the agent's
#      own log and says whether it reached the API, was rejected, or could
#      not connect. A service that died is a FAILURE here, never "Done".
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
# Re-running is safe: it re-copies the files, asks about an existing
# agent.json, and re-registers the service. Day-to-day UPDATES do not need
# it: the installed agent fetches newer builds from the API by itself
# (D183). Re-run this only to change the token/address or after a wedged
# agent, or when node.exe or nssm themselves must change.
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

# Run nssm and return what it printed, never throwing. Two Windows PowerShell
# 5.1 facts make this necessary: a native program's stderr redirected with
# 2>&1 becomes an ErrorRecord, and under $ErrorActionPreference = "Stop" that
# record TERMINATES the script - so nssm's harmless "STOP: The service has not
# been started" once ended an install as FAILED. And nssm prints UTF-16, so
# the text is cleaned before anyone compares it.
function Invoke-Nssm {
  param([string]$Exe, [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $out = & $Exe @Rest 2>&1 | ForEach-Object { "$_" }
    $script:NssmExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
  }
  return (($out -join " ") -replace "[^\x20-\x7E]", "").Trim()
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
    if ($nssm) { Invoke-Nssm $nssm stop $ServiceName confirm | Out-Null; Invoke-Nssm $nssm remove $ServiceName confirm | Out-Null }
    else { Stop-Service $ServiceName -Force -ErrorAction SilentlyContinue; sc.exe delete $ServiceName | Out-Null }
    Remove-Item "$InstallDir\dist.prev", "$InstallDir\dist.next", "$InstallDir\dist.broken", "$InstallDir\scripts.prev", "$InstallDir\scripts.next", "$InstallDir\scripts.broken", "$InstallDir\update.json", "$InstallDir\update-failed.json" -Recurse -Force -ErrorAction SilentlyContinue
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
$foundNode = $node.Source
$nodeVersion = (& $foundNode --version)
if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 20) {
  throw "Node.js $nodeVersion is too old; the agent needs 20 or newer. Install Node.js LTS from https://nodejs.org/en/download."
}
# Follow junctions/symlinks (nvm-for-Windows, scoop, volta) to the real file,
# then keep our own copy: node.exe is a single self-contained binary, and a
# service must not depend on a per-user tool being where it was at install.
$realNode = $foundNode
try {
  $item = Get-Item $foundNode
  $dir = Get-Item (Split-Path $foundNode -Parent)
  if ($dir.LinkType -and $dir.Target) { $realNode = Join-Path ([string]$dir.Target) $item.Name }
  elseif ($item.LinkType -and $item.Target) { $realNode = [string]$item.Target }
} catch { }
if (-not (Test-Path $realNode)) { $realNode = $foundNode }
Ok "Node.js $nodeVersion found at $foundNode"

# ── 3. files ────────────────────────────────────────────────────────────────
Step "Copying the agent to $InstallDir"
foreach ($required in @("dist\index.js", "scripts\windows-raw-printer.ps1", "package.json")) {
  if (-not (Test-Path "$Here\$required")) { throw "This folder is missing $required - unzip the whole release and run install.ps1 from inside it." }
}
foreach ($sub in @("tools", "dist", "scripts")) { New-Item -ItemType Directory -Force "$InstallDir\$sub" | Out-Null }
# Copy the CONTENTS: Copy-Item of a folder into an existing folder nests it
# (dist\dist) on every re-run.
Copy-Item "$Here\dist\*" "$InstallDir\dist" -Recurse -Force
Copy-Item "$Here\scripts\*" "$InstallDir\scripts" -Recurse -Force
Remove-Item "$InstallDir\dist\dist", "$InstallDir\scripts\scripts" -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item "$Here\package.json" "$InstallDir\package.json" -Force
if (Test-Path "$Here\README-CUSTOMER.md") { Copy-Item "$Here\README-CUSTOMER.md" "$InstallDir\README-CUSTOMER.md" -Force }
# Files from a downloaded zip carry the "mark of the web"; the agent runs the
# spooler helper with -ExecutionPolicy Bypass, but clear it anyway so nothing
# else on the machine ever refuses them.
Get-ChildItem $InstallDir -Recurse -File | Unblock-File -ErrorAction SilentlyContinue
$nodeExe = "$InstallDir\tools\node.exe"
if ((Test-Path $nodeExe) -and (Get-Service $ServiceName -ErrorAction SilentlyContinue)) {
  # The old service may still hold the file open; stop it before overwriting.
  $oldNssm = Find-Nssm
  if ($oldNssm) { Invoke-Nssm $oldNssm stop $ServiceName confirm | Out-Null } else { Stop-Service $ServiceName -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1
}
Copy-Item $realNode $nodeExe -Force
$bundledVersion = (& $nodeExe --version)
Ok "Files in place; the service will run its own copy of Node.js $bundledVersion"

# ── 4. agent.json ───────────────────────────────────────────────────────────
Step "Configuring"
$configPath = "$InstallDir\agent.json"
$existing = $null
if (Test-Path $configPath) {
  try { $existing = ((Get-Content $configPath -Raw) -replace "^\xEF\xBB\xBF|^\uFEFF", "") | ConvertFrom-Json } catch { $existing = $null }
}
$keepExisting = $false
if ($existing -and -not $Token -and -not $PSBoundParameters.ContainsKey('ApiUrl')) {
  # A leftover from an earlier attempt is the usual case here, and it is
  # usually WRONG (the first customer install kept one that pointed at the
  # cloud API). Show it; keeping it is a choice, not the default silence.
  Write-Host ""
  Write-Host "    This PC already has an agent.json:" -ForegroundColor White
  Write-Host "      name:        $($existing.name)" -ForegroundColor White
  Write-Host "      API address: $($existing.apiUrl)" -ForegroundColor White
  Write-Host "      token:       $(if ($existing.token) { ([string]$existing.token).Substring(0, [Math]::Min(8, ([string]$existing.token).Length)) + '...' } else { '(none)' })" -ForegroundColor White
  $answer = (Read-Host "    Keep it? Type y to keep, or n to enter a new API address and token [y/N]").Trim()
  $keepExisting = ($answer -match '^[Yy]')
}
if ($keepExisting) {
  # Re-save it without a byte-order mark, in case the old installer wrote one.
  $config = [ordered]@{ apiUrl = ([string]$existing.apiUrl).Trim(); token = [string]$existing.token; name = $(if ($existing.name) { [string]$existing.name } else { $Name }) }
  [IO.File]::WriteAllText($configPath, (($config | ConvertTo-Json) + "`n"), (New-Object System.Text.UTF8Encoding $false))
  Ok "Keeping agent.json for '$($config.name)' -> $($config.apiUrl)"
} else {
  if (-not $PSBoundParameters.ContainsKey('ApiUrl')) {
    Write-Host ""
    Write-Host "    The token only works on the API it was paired on. The app shows that" -ForegroundColor White
    Write-Host "    address next to the token (for example http://192.168.0.5:4000)." -ForegroundColor White
    $typed = (Read-Host "    API address [$ApiUrl]").Trim()
    if ($typed) { $ApiUrl = $typed }
  }
  # People paste what the browser shows: strip a trailing /v1 or /, and the
  # web app's port if they pasted the app instead of the API by mistake is
  # not something we can guess - so only the shape is checked.
  $ApiUrl = $ApiUrl.Trim() -replace '/v1/?$', '' -replace '/+$', ''
  if ($ApiUrl -notmatch '^https?://[^/\s]+') { throw "The API address must look like https://api.example.com or http://192.168.0.5:4000 (got '$ApiUrl')." }
  if (-not $Token) {
    Write-Host ""
    Write-Host "    In the app: Settings -> Printing -> Print agent -> Pair a new agent." -ForegroundColor White
    Write-Host "    Copy the token it shows (it starts with pat_) and paste it here." -ForegroundColor White
    $Token = (Read-Host "    Pairing token").Trim()
  }
  if ($Token -notmatch '^pat_') { throw "That does not look like a pairing token (it starts with pat_)." }
  $config = [ordered]@{ apiUrl = $ApiUrl; token = $Token; name = $Name }
  # NOT Set-Content -Encoding UTF8: on Windows PowerShell that writes a
  # byte-order mark, and JSON.parse in the agent refuses the file - the
  # service then dies with "not configured" while agent.json sits right there.
  [IO.File]::WriteAllText($configPath, (($config | ConvertTo-Json) + "`n"), (New-Object System.Text.UTF8Encoding $false))
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
  Invoke-Nssm $nssm stop $ServiceName confirm | Out-Null
  Invoke-Nssm $nssm remove $ServiceName confirm | Out-Null
  Start-Sleep -Seconds 1
}
$installed = Invoke-Nssm $nssm install $ServiceName $nodeExe "`"$InstallDir\dist\index.js`""
if ($script:NssmExit -ne 0) { throw "nssm could not register the service: $installed" }
foreach ($setting in @(
  @("AppDirectory", $InstallDir),
  @("DisplayName", "AxloPOS print agent"),
  @("Description", "Prints AxloPOS kitchen tickets and bills on this shop's printers."),
  @("Start", "SERVICE_AUTO_START"),
  @("AppStdout", "$InstallDir\agent.log"),
  @("AppStderr", "$InstallDir\agent.log"),
  @("AppRotateFiles", "1"),
  @("AppRotateBytes", "5000000"),
  @("AppExit", "Default", "Restart"),
  @("AppRestartDelay", "5000")
)) { Invoke-Nssm $nssm set $ServiceName @setting | Out-Null }
# Registered without AppExit throttling surprises: nssm pauses a service whose
# program keeps exiting at once, and reports it as SERVICE_PAUSED on start.
Invoke-Nssm $nssm start $ServiceName | Out-Null
# Ask Windows, not nssm: nssm prints its status as UTF-16 and the captured
# text carries invisible characters, so "SERVICE_RUNNING" never compared
# equal and a healthy install was reported as FAILED.
$svcState = "unknown"
$statusDeadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $statusDeadline) {
  Start-Sleep -Seconds 1
  $svcState = [string](Get-Service $ServiceName -ErrorAction SilentlyContinue).Status
  if ($svcState -eq "Running") {
    # nssm reports Running while it is still deciding; give the program a
    # moment to die if it is going to, so a crash loop is caught here.
    Start-Sleep -Seconds 3
    $svcState = [string](Get-Service $ServiceName -ErrorAction SilentlyContinue).Status
    if ($svcState -eq "Running") { break }
  }
  if ($svcState -match "Paused|Stopped") { break }
}
if ($svcState -ne "Running") {
  Write-Host ""
  Write-Host "    The service is $svcState - the agent program exited straight away." -ForegroundColor Red
  $agentLog = "$InstallDir\agent.log"
  if ((Test-Path $agentLog) -and (Get-Item $agentLog).Length -gt 0) {
    Write-Host "    Last lines of $agentLog :" -ForegroundColor Yellow
    Get-Content $agentLog -Tail 15 | ForEach-Object { Write-Host "      $_" }
  } else {
    Write-Host "    $agentLog is empty: node.exe itself did not start." -ForegroundColor Yellow
  }
  try {
    $events = Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = 'nssm' } -MaxEvents 5 -ErrorAction Stop
    Write-Host "    NSSM events:" -ForegroundColor Yellow
    $events | ForEach-Object { Write-Host "      $($_.TimeCreated.ToString('HH:mm:ss')) $($_.Message -replace '\s+', ' ')" }
  } catch { }
  throw "The agent could not start (service $svcState). See the lines above; the full transcript is in $LogPath."
}
Ok "Service installed and running (auto-start at boot, restarts on failure)"

# ── 6. power ────────────────────────────────────────────────────────────────
Step "Stopping the PC from sleeping on mains power"
powercfg /change standby-timeout-ac 0 | Out-Null
powercfg /change hibernate-timeout-ac 0 | Out-Null
Ok "Sleep and hibernate on AC: never"

# ── 7. verify ───────────────────────────────────────────────────────────────
Step "Waiting for the agent to check in"
$log = "$InstallDir\agent.log"
$deadline = (Get-Date).AddSeconds(45)
$status = "unknown"
$apiUrlNow = (Get-Content $configPath -Raw | ConvertFrom-Json).apiUrl
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  if (Test-Path $log) {
    $tail = (Get-Content $log -Tail 20 -ErrorAction SilentlyContinue) -join "`n"
    if ($tail -match "not configured|Could not read") { $status = "unconfigured"; break }
    if ($tail -match "HTTP 401") { $status = "rejected"; break }
    if ($tail -match "ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|fetch failed") { $status = "unreachable"; break }
    if ($tail -match "discovery:") { $status = "ok"; break }
    if ($tail -match "starting v") { $status = "started" }
  }
}
switch ($status) {
  "ok"          { Ok "The agent reached $apiUrlNow and scanned for printers. Settings -> Printing shows it Online." }
  "started"     { Ok "The agent started and is talking to $apiUrlNow. Settings -> Printing should show Online within a minute." }
  "unconfigured" { throw "The agent could not read $configPath (see $log). Run install.cmd again with -Token to rewrite it." }
  "rejected"    { throw "The API at $apiUrlNow rejected the token (HTTP 401): it was revoked, or it was paired on a different API address. Pair a new agent in the app and run install.cmd again with the address the app shows." }
  "unreachable" { throw "Cannot reach $apiUrlNow from this PC. Is that the address the app shows next to the token, is the API running, and is this PC on the same network? Run install.cmd again with the right address." }
  default       { Warn "The service is running but has not logged a check-in yet. Watch $log; Settings -> Printing shows Online once it does." }
}
Write-Host ""
Write-Host "Done. Agent log: $log" -ForegroundColor White
Write-Host "Manage: $InstallDir\tools\nssm.exe start|stop|restart $ServiceName   Remove: install.cmd -Uninstall" -ForegroundColor White
Finish 0
