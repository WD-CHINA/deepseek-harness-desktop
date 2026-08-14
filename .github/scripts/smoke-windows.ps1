$ErrorActionPreference = 'Stop'

$app = Get-ChildItem -Path 'release/win-unpacked' -Filter '*.exe' |
  Where-Object { $_.Name -eq 'DeepSeek Harness Desktop.exe' } |
  Select-Object -First 1

if ($null -eq $app) {
  throw 'Packaged Windows executable was not found.'
}

$desktop = Start-Process `
  -FilePath $app.FullName `
  -ArgumentList @('--workspace', (Get-Location).Path) `
  -PassThru

$harness = $null
$listener = $null

try {
  $deadline = (Get-Date).AddSeconds(90)

  while ((Get-Date) -lt $deadline) {
    if ($desktop.HasExited) {
      throw "Desktop process exited before Harness was ready: $($desktop.ExitCode)"
    }

    $harness = Get-CimInstance Win32_Process |
      Where-Object {
        $_.ParentProcessId -eq $desktop.Id -and
        $_.CommandLine -match '--expose-internals' -and
        $_.CommandLine -match '\bweb\s+--port\s+0\b'
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
    throw 'Harness did not expose a loopback listener within 90 seconds.'
  }

  $response = Invoke-WebRequest `
    -Uri "http://127.0.0.1:$($listener.LocalPort)/" `
    -UseBasicParsing `
    -TimeoutSec 15

  if ($response.StatusCode -ne 200) {
    throw "Harness returned HTTP $($response.StatusCode)."
  }

  if (-not $desktop.CloseMainWindow()) {
    throw 'Unable to request a graceful desktop window close.'
  }

  if (-not $desktop.WaitForExit(15000)) {
    throw 'Desktop process did not exit within 15 seconds.'
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
