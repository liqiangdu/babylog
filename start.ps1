param(
    [switch]$NoNewWindow
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$backend = Join-Path $root "backend"

if (-not (Test-Path $backend)) {
    throw "Backend directory not found: $backend"
}

$frontendCmd = "cd `"$root`"; npx --yes serve ."
$backendCmd = "cd `"$backend`"; `$env:PATH = `"C:\msys64\mingw64\bin;`" + `$env:PATH; cargo run"

# Force restart backend: stop current listener on 8787 first.
try {
    $existing = Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
    if ($existing) {
        $pids = $existing | Select-Object -ExpandProperty OwningProcess -Unique
        foreach ($pid in $pids) {
            Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
            Write-Host "[backend]  stopped existing process PID=$pid on 127.0.0.1:8787"
        }
    }
} catch {
    Write-Host "[backend]  warning: failed to pre-stop existing process on 8787"
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
