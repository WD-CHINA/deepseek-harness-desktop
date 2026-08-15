$ErrorActionPreference = 'Stop'

# Windows smoke test: launch packaged app, verify Harness listener, test shutdown.
# Keep timeout aligned with macOS (120s). Smoke mode skips foreground plugin install.

$app = Get-ChildItem -Path 'release/win-unpacked' -Filter '*.exe' |
  Where-Object { $_.Name -eq 'DeepSeek Harness Desktop.exe' } |
  Select-Object -First 1

if ($null -eq $app) {
  throw 'Packaged Windows executable was not found.'
}

Write-Host "Found app: $($app.FullName)"

$desktop = Start-Process `
  -FilePath $app.FullName `
  -ArgumentList @(
    '--workspace',
    (Get-Location).Path,
    '--smoke-test-exit-after-ready'
  ) `
  -PassThru

Write-Host "Desktop PID: $($desktop.Id)"

$harness = $null
$listener = $null

try {
  $deadline = (Get-Date).AddSeconds(120)

  while ((Get-Date) -lt $deadline) {
    if ($desktop.HasExited) {
      throw "Desktop process exited before Harness was ready: $($desktop.ExitCode)"
    }

    # Match Electron-as-Node DSH child: --expose-internals ... web --port 0
    # (may include dsh-node-entry.js between expose-internals and web)
    $harness = Get-CimInstance Win32_Process |
      Where-Object {
        $_.ParentProcessId -eq $desktop.Id -and
        $_.CommandLine -match '--expose-internals' -and
        $_.CommandLine -match '(^|\s)web(\s|$)' -and
        $_.CommandLine -match '--port(\s|=)0(\s|$)'
      } |
      Select-Object -First 1

    if ($null -ne $harness) {
      $listener = Get-NetTCPConnection `
        -OwningProcess $harness.ProcessId `
        -State Listen `
        -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -eq '127.0.0.1' } |
        Select-Object -First 1

      if ($null -ne $listener) {
        break
      }
    }

    Start-Sleep -Milliseconds 500
  }

  if ($null -eq $harness -or $null -eq $listener) {
    Write-Host '--- diagnostics: child processes ---'
    Get-CimInstance Win32_Process |
      Where-Object { $_.ParentProcessId -eq $desktop.Id } |
      ForEach-Object { Write-Host "PID=$($_.ProcessId) CMD=$($_.CommandLine)" }
    throw 'Harness did not expose a loopback listener within 120 seconds.'
  }

  Write-Host "Found Harness listener on port $($listener.LocalPort) (PID $($harness.ProcessId))"

  $response = Invoke-WebRequest `
    -Uri "http://127.0.0.1:$($listener.LocalPort)/" `
    -UseBasicParsing `
    -TimeoutSec 15

  if ($response.StatusCode -ne 200) {
    throw "Harness returned HTTP $($response.StatusCode)."
  }

  Write-Host 'HTTP check passed (200 OK)'

  if (-not $desktop.WaitForExit(30000)) {
    throw 'Desktop process did not complete its graceful smoke-test shutdown within 30 seconds.'
  }

  Start-Sleep -Seconds 1

  if ($null -ne (Get-Process -Id $harness.ProcessId -ErrorAction SilentlyContinue)) {
    throw "Harness child process $($harness.ProcessId) survived desktop shutdown."
  }

  $remainingListener = Get-NetTCPConnection `
    -LocalPort $listener.LocalPort `
    -State Listen `
    -ErrorAction SilentlyContinue

  if ($null -ne $remainingListener) {
    throw "Harness listener on port $($listener.LocalPort) survived desktop shutdown."
  }

  Write-Host "Windows packaged smoke test passed on port $($listener.LocalPort)."
}
finally {
  if (-not $desktop.HasExited) {
    & taskkill.exe /PID $desktop.Id /T /F | Out-Null
  }
}
