param(
    [switch]$NoNewWindow
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$backend = Join-Path $root "backend"

if (-not (Test-Path $backend)) {
    throw "Backend directory not found: $backend"
}

if (-not $env:BACKEND_PORT) { $env:BACKEND_PORT = "8787" }
if (-not $env:BABYLOG_LISTEN) { $env:BABYLOG_LISTEN = "127.0.0.1:$($env:BACKEND_PORT)" }

$frontendCmd = "cd `"$root`"; if (-not (Test-Path node_modules)) { npm install }; npm run dev"
$backendCmd = "cd `"$backend`"; cargo run"

# Force restart backend: stop any listener on BACKEND_PORT first.
try {
    $port = [int]$env:BACKEND_PORT
    $existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($existing) {
        $pids = $existing | Select-Object -ExpandProperty OwningProcess -Unique
        foreach ($pid in $pids) {
            Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
            Write-Host "[backend]  stopped existing process PID=$pid on port $port"
        }
    }
} catch {
    Write-Host "[backend]  warning: failed to pre-stop existing process on $($env:BACKEND_PORT)"
}

if ($NoNewWindow) {
    Write-Host "[frontend] $frontendCmd"
    Start-Job -ScriptBlock { param($cmd) powershell -NoLogo -NoExit -Command $cmd } -ArgumentList $frontendCmd | Out-Null

    Write-Host "[backend]  $backendCmd"
    Start-Job -ScriptBlock { param($cmd) powershell -NoLogo -NoExit -Command $cmd } -ArgumentList $backendCmd | Out-Null

    Write-Host "Started both services as background jobs."
    Write-Host "Use 'Get-Job' to inspect, and 'Stop-Job *' to stop."
} else {
    Start-Process powershell -ArgumentList "-NoLogo", "-NoExit", "-Command", $frontendCmd | Out-Null
    Start-Process powershell -ArgumentList "-NoLogo", "-NoExit", "-Command", $backendCmd | Out-Null
    Write-Host "Started frontend and backend in new PowerShell windows."
}
