# dsh-stm32 serial bridge (P1, Windows only)
#
# Why this file exists: Node has no built-in serial port support and this plugin has a
# hard zero-npm-dependency rule. Windows ships PowerShell + System.IO.Ports.SerialPort,
# so the port lives in a small detached PowerShell process and Node talks to it through
# files in one IPC directory.
#
# Contract (the engine in src/engine/serial.ts is the only other side of it):
#   env  DSH_STM32_SERIAL_IPC   IPC directory (also accepted as -IpcDir)
#   in   session.json           written by the engine before spawn (port/settings/parentPid)
#   out  status.json            {state: opening|open|closed|error, pid, error:{kind,cause,hint}, ...}
#   out  rx.ndjson / tx.ndjson  one JSON record per line: {t:<epoch ms>, d:"<text>"[, p:true]}
#   in   cmd/<id>.json          made by writing a temp file then renaming it into cmd/
#   out  done/<id>.json         {id, ok, action, at, error?:{kind,cause}, data?:{...}}
#   out  bridge.pid / bridge.log
#
# Loop shape: poll the port every ~20 ms, scan cmd/ every 100 ms (contract: 100 ms),
# heartbeat status.json every 1 s, verify the parent PID every 5 s (a detached process
# whose parent was killed would otherwise keep the COM port hostage forever).
#
# IMPORTANT: this file is intentionally pure ASCII. Windows PowerShell 5.1 decodes
# BOM-less .ps1 files with the ANSI code page, so any non-ASCII text here would come out
# as mojibake in bridge.log. User-facing Chinese text lives in serial.ts, not here.

param(
  [string]$IpcDir = $env:DSH_STM32_SERIAL_IPC
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($IpcDir)) {
  # No IPC directory means we cannot even report the failure; the engine maps this exit
  # code to bridge-start-timeout / bridge-crashed.
  exit 2
}

$script:Utf8 = New-Object System.Text.UTF8Encoding($false)
$script:IpcDir = $IpcDir
$script:SessionPath = Join-Path $IpcDir 'session.json'
$script:StatusPath = Join-Path $IpcDir 'status.json'
$script:PidPath = Join-Path $IpcDir 'bridge.pid'
$script:LogPath = Join-Path $IpcDir 'bridge.log'
$script:RxPath = Join-Path $IpcDir 'rx.ndjson'
$script:TxPath = Join-Path $IpcDir 'tx.ndjson'
$script:CmdDir = Join-Path $IpcDir 'cmd'
$script:DoneDir = Join-Path $IpcDir 'done'

$script:SessionId = ''
$script:PortName = ''
$script:OpenedAt = ''
$script:ParentPid = 0
$script:Encoding = New-Object System.Text.UTF8Encoding($false)
$script:Newline = "`r`n"
$script:IdleTimeoutMs = 600000
$script:MaxLogBytes = 8388608
$script:ScanMs = 100
$script:RxBytes = 0
$script:TxBytes = 0
$script:Pending = New-Object System.Text.StringBuilder
$script:Port = $null

function Get-NowMs {
  return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}

function Get-NowIso {
  return [DateTime]::UtcNow.ToString('o')
}

# Keep one log/ndjson file bounded: when it passes the cap, keep the newest half and cut
# at a line boundary (a half JSON line at the top would poison every later parse).
function Trim-File {
  param([string]$Path)
  try {
    if (-not [System.IO.File]::Exists($Path)) { return }
    $length = (New-Object System.IO.FileInfo($Path)).Length
    if ($length -le $script:MaxLogBytes) { return }
    $keep = [long]($script:MaxLogBytes / 2)
    if ($keep -lt 4096) { $keep = 4096 }
    $text = [System.IO.File]::ReadAllText($Path, $script:Utf8)
    if ($text.Length -le $keep) { return }
    $start = [int]($text.Length - $keep)
    $index = $text.IndexOf("`n", $start)
    if ($index -lt 0) { $index = $start - 1 }
    [System.IO.File]::WriteAllText($Path, $text.Substring($index + 1), $script:Utf8)
  } catch {
    # Trimming is best effort: never let log housekeeping kill a live session.
  }
}

function Write-BridgeLog {
  param([string]$Level, [string]$Text)
  try {
    $line = '[' + (Get-NowIso) + '] ' + $Level + ' ' + $Text + "`n"
    [System.IO.File]::AppendAllText($script:LogPath, $line, $script:Utf8)
    Trim-File $script:LogPath
  } catch { }
}

function Write-JsonAtomic {
  param([string]$Path, $Object)
  $json = $Object | ConvertTo-Json -Depth 8 -Compress
  $tmp = $Path + '.tmp-' + $PID
  [System.IO.File]::WriteAllText($tmp, $json, $script:Utf8)
  Move-Item -LiteralPath $tmp -Destination $Path -Force
}

function Read-Json {
  param([string]$Path)
  if (-not [System.IO.File]::Exists($Path)) { return $null }
  try {
    $text = [System.IO.File]::ReadAllText($Path, $script:Utf8)
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    return ($text | ConvertFrom-Json)
  } catch {
    return $null
  }
}

function Write-Ndjson {
  param([string]$Path, $Record)
  try {
    $line = ($Record | ConvertTo-Json -Depth 4 -Compress) + "`n"
    [System.IO.File]::AppendAllText($Path, $line, $script:Utf8)
    Trim-File $Path
  } catch { }
}

function Write-Status {
  param([string]$State, [string]$Reason, $ErrorInfo)
  $status = [ordered]@{
    state = $State
    pid = $PID
    sessionId = $script:SessionId
    port = $script:PortName
    openedAt = $script:OpenedAt
    updatedAt = (Get-NowIso)
    rxBytes = $script:RxBytes
    txBytes = $script:TxBytes
    reason = $Reason
  }
  if ($null -ne $ErrorInfo) { $status['error'] = $ErrorInfo }
  try { Write-JsonAtomic $script:StatusPath $status } catch { }
}

function Write-RxRecord {
  param([string]$Text, [bool]$Partial)
  if ($Text.Length -eq 0 -and -not $Partial) { return }
  if ($Text.Length -eq 0) { return }
  $record = [ordered]@{ t = (Get-NowMs); d = $Text }
  if ($Partial) { $record['p'] = $true }
  Write-Ndjson $script:RxPath $record
}

# Turn the decoded character buffer into whole lines. -Force also emits the trailing
# fragment as {p:true}: a shell prompt ("ok> ") never ends with a newline, so without the
# forced flush the last thing the board said would sit in RAM until the next newline.
function Flush-RxLines {
  param([switch]$Force)
  $text = $script:Pending.ToString()
  if ($text.Length -eq 0) { return }
  $start = 0
  while ($true) {
    $index = $text.IndexOf("`n", $start)
    if ($index -lt 0) { break }
    $line = $text.Substring($start, $index - $start).TrimEnd("`r")
    Write-RxRecord -Text $line -Partial $false
    $start = $index + 1
  }
  $rest = $text.Substring($start)
  if ($Force -and $rest.Length -gt 0) {
    Write-RxRecord -Text $rest.TrimEnd("`r") -Partial $true
    $rest = ''
  }
  [void]$script:Pending.Clear()
  if ($rest.Length -gt 0) { [void]$script:Pending.Append($rest) }
}

function Test-ParentAlive {
  if ($script:ParentPid -le 0) { return $true }
  try {
    $process = [System.Diagnostics.Process]::GetProcessById($script:ParentPid)
    if ($process.HasExited) { return $false }
    return $true
  } catch {
    return $false
  }
}

function Write-Done {
  param([string]$Id, $Result)
  if ($Id -eq '' -or $Id -eq $null) { return }
  $safe = $Id -replace '[^A-Za-z0-9_-]', '_'
  try { Write-JsonAtomic (Join-Path $script:DoneDir ($safe + '.json')) $Result } catch { }
}

function New-ErrorInfo {
  param([string]$Kind, [string]$Cause, [string]$Hint)
  return [ordered]@{ kind = $Kind; cause = $Cause; hint = $Hint }
}

# Map a .NET open() failure onto the engine's error kinds. A pre-check of GetPortNames()
# settles "does not exist" with certainty, so what is left here is mostly "somebody else
# holds the port" (UnauthorizedAccessException) versus bad settings (ArgumentException).
function Invoke-BridgeCommand {
  param($Command)
  $action = [string]$Command.action
  $id = [string]$Command.id
  $at = Get-NowMs
  $base = [ordered]@{ id = $id; ok = $false; action = $action; at = $at }

  switch ($action) {
    'send' {
      $text = [string]$Command.text
      $raw = $false
      if ($null -ne $Command.raw) { $raw = [bool]$Command.raw }
      $suffix = $script:Newline
      if ($null -ne $Command.newline) {
        $want = [string]$Command.newline
        if ($want -eq 'crlf') { $suffix = "`r`n" } elseif ($want -eq 'lf') { $suffix = "`n" } elseif ($want -eq 'none') { $suffix = '' }
      }
      try {
        if ($raw) {
          $payload = $script:Encoding.GetBytes($text)
        } else {
          $payload = $script:Encoding.GetBytes($text + $suffix)
        }
        $script:Port.Write($payload, 0, $payload.Length)
        $script:TxBytes += $payload.Length
        Write-Ndjson $script:TxPath ([ordered]@{ t = $at; d = $text; n = $payload.Length })
        $result = [ordered]@{ id = $id; ok = $true; action = 'send'; at = $at }
        $result['data'] = [ordered]@{ bytes = $payload.Length; txBytes = $script:TxBytes; rxBytes = $script:RxBytes }
        return $result
      } catch {
        $base['error'] = (New-ErrorInfo 'disconnected' ([string]$_.Exception.Message) 'Write failed: the port or the bridge is gone; reopen the session.')
        return $base
      }
    }
    'ping' {
      $result = [ordered]@{ id = $id; ok = $true; action = 'ping'; at = $at }
      $result['data'] = [ordered]@{
        state = 'open'
        port = $script:PortName
        rxBytes = $script:RxBytes
        txBytes = $script:TxBytes
        pendingChars = $script:Pending.Length
        uptimeMs = ((Get-NowMs) - $script:StartedAtMs)
      }
      return $result
    }
    'lines' {
      try {
        if ($null -ne $Command.dtr) { $script:Port.DtrEnable = [bool]$Command.dtr }
        if ($null -ne $Command.rts) { $script:Port.RtsEnable = [bool]$Command.rts }
        $result = [ordered]@{ id = $id; ok = $true; action = 'lines'; at = $at }
        $result['data'] = [ordered]@{ dtr = $script:Port.DtrEnable; rts = $script:Port.RtsEnable }
        return $result
      } catch {
        $base['error'] = (New-ErrorInfo 'disconnected' ([string]$_.Exception.Message) 'Toggling DTR/RTS failed; reopen the session.')
        return $base
      }
    }
    'close' {
      $result = [ordered]@{ id = $id; ok = $true; action = 'close'; at = $at }
      $result['data'] = [ordered]@{ port = $script:PortName }
      return $result
    }
    default {
      $base['error'] = (New-ErrorInfo 'settings-invalid' ('unknown bridge action: ' + $action) 'Only send / ping / lines / close are supported.')
      return $base
    }
  }
}

# ---- boot -------------------------------------------------------------------

try {
  New-Item -ItemType Directory -Path $script:CmdDir -Force | Out-Null
  New-Item -ItemType Directory -Path $script:DoneDir -Force | Out-Null
} catch {
  exit 3
}

[System.IO.File]::WriteAllText($script:PidPath, [string]$PID, $script:Utf8)

$session = Read-Json $script:SessionPath
if ($null -eq $session) {
  Write-BridgeLog 'error' 'session.json missing or unparsable; exiting'
  Write-Status 'error' 'no-session' (New-ErrorInfo 'no-session' 'session.json missing or unparsable' 'The engine writes session.json before spawning the bridge; re-run open.')
  exit 3
}

$script:SessionId = [string]$session.sessionId
$script:PortName = ([string]$session.port).ToUpper()
$script:ParentPid = [int]$session.parentPid
if ($null -ne $session.idleTimeoutMs) { $script:IdleTimeoutMs = [int]$session.idleTimeoutMs }
if ($null -ne $session.maxLogBytes) { $script:MaxLogBytes = [long]$session.maxLogBytes }
if ($null -ne $session.scanMs) { $script:ScanMs = [int]$session.scanMs }
if ($script:ScanMs -lt 20) { $script:ScanMs = 20 }

switch ([string]$session.encoding) {
  'ascii' { $script:Encoding = [System.Text.Encoding]::ASCII }
  'latin1' { $script:Encoding = [System.Text.Encoding]::GetEncoding(28591) }
  default { $script:Encoding = New-Object System.Text.UTF8Encoding($false) }
}

switch ([string]$session.newline) {
  'lf' { $script:Newline = "`n" }
  'none' { $script:Newline = '' }
  default { $script:Newline = "`r`n" }
}

Write-BridgeLog 'info' ('bridge start pid=' + $PID + ' port=' + $script:PortName + ' session=' + $script:SessionId)
Write-Status 'opening' '' $null

$script:StartedAtMs = Get-NowMs
$script:Port = New-Object System.IO.Ports.SerialPort

try {
  # Trust GetPortNames() for existence: open() on a missing port throws an IOException
  # whose text varies with the .NET version, and "does not exist" vs "in use" is exactly
  # the distinction the engine needs.
  $known = @([System.IO.Ports.SerialPort]::GetPortNames() | ForEach-Object { $_.ToUpper() })
  if (-not ($known -contains $script:PortName)) {
    $cause = 'port ' + $script:PortName + ' is not present (present: ' + ($known -join ', ') + ')'
    Write-BridgeLog 'error' $cause
    Write-Status 'error' 'open-failed' (New-ErrorInfo 'port-not-found' $cause 'Check the USB cable and listPorts; the COM number changes when the board is re-plugged.')
    try { if ($script:Port.IsOpen) { $script:Port.Close() } } catch { }
    exit 4
  }

  $script:Port.PortName = $script:PortName
  $script:Port.BaudRate = [int]$session.baudRate
  $script:Port.DataBits = [int]$session.dataBits
  switch ([string]$session.parity) {
    'odd' { $script:Port.Parity = [System.IO.Ports.Parity]::Odd }
    'even' { $script:Port.Parity = [System.IO.Ports.Parity]::Even }
    'mark' { $script:Port.Parity = [System.IO.Ports.Parity]::Mark }
    'space' { $script:Port.Parity = [System.IO.Ports.Parity]::Space }
    default { $script:Port.Parity = [System.IO.Ports.Parity]::None }
  }
  switch ([string]$session.stopBits) {
    '1.5' { $script:Port.StopBits = [System.IO.Ports.StopBits]::OnePointFive }
    '2' { $script:Port.StopBits = [System.IO.Ports.StopBits]::Two }
    default { $script:Port.StopBits = [System.IO.Ports.StopBits]::One }
  }
  switch ([string]$session.flow) {
    'xonxoff' { $script:Port.Handshake = [System.IO.Ports.Handshake]::XOnXOff }
    'rtscts' { $script:Port.Handshake = [System.IO.Ports.Handshake]::RequestToSend }
    default { $script:Port.Handshake = [System.IO.Ports.Handshake]::None }
  }
  $script:Port.DtrEnable = [bool]$session.dtr
  $script:Port.RtsEnable = [bool]$session.rts
  $script:Port.ReadTimeout = 1000
  $script:Port.WriteTimeout = 1000
  $script:Port.Open()
} catch {
  $exception = $_.Exception
  $typeName = $exception.GetType().FullName
  $message = [string]$exception.Message
  $kind = 'port-busy'
  if ($typeName -like '*ArgumentException*' -or $typeName -like '*InvalidOperationException*') {
    if ($message -match 'denied|in use|busy|being used') { $kind = 'port-busy' } else { $kind = 'settings-invalid' }
  } elseif ($message -match 'denied|in use|busy|being used') {
    $kind = 'port-busy'
  }
  Write-BridgeLog 'error' ('open failed: ' + $typeName + ': ' + $message)
  Write-Status 'error' 'open-failed' (New-ErrorInfo $kind $message 'Another program may hold the port (a serial monitor or a second session), or the settings are not supported by this adapter.')
  try { if ($script:Port.IsOpen) { $script:Port.Close() } } catch { }
  exit 4
}

$script:OpenedAt = Get-NowIso
Write-BridgeLog 'info' ('port open at ' + [int]$session.baudRate + ' ' + [int]$session.dataBits + 'N1')
Write-Status 'open' '' $null

# ---- main loop --------------------------------------------------------------

$buffer = [byte[]]::new(4096)
$decoder = $script:Encoding.GetDecoder()
$lastCommandAt = Get-NowMs
$lastScanAt = 0
$lastParentCheck = Get-NowMs
$lastStatusAt = Get-NowMs
$lastRxAt = Get-NowMs
$running = $true
$reason = 'requested'

while ($running) {
  $now = Get-NowMs

  # 1) drain whatever the board sent; decode with a stateful decoder so a multi-byte
  #    UTF-8 character split across two reads does not become mojibake.
  try {
    while ($script:Port.BytesToRead -gt 0) {
      $count = $script:Port.Read($buffer, 0, $buffer.Length)
      if ($count -le 0) { break }
      $script:RxBytes += $count
      $charCount = $decoder.GetCharCount($buffer, 0, $count)
      if ($charCount -gt 0) {
        $chars = [char[]]::new($charCount)
        [void]$decoder.GetChars($buffer, 0, $count, $chars, 0)
        [void]$script:Pending.Append($chars)
      }
      $lastRxAt = $now
      if ($script:Pending.Length -gt 8192) { Flush-RxLines -Force }
    }
  } catch {
    Write-BridgeLog 'error' ('read failed: ' + [string]$_.Exception.Message)
    Write-Status 'error' 'read-failed' (New-ErrorInfo 'disconnected' ([string]$_.Exception.Message) 'The port disappeared (cable pulled or device reset); reopen the session.')
    $reason = 'read-failed'
    break
  }

  # A prompt without a trailing newline would otherwise never be reported: flush the
  # fragment once the line has been quiet for a moment (or straight away on command).
  if (($script:Pending.Length -gt 0) -and (($now - $lastRxAt) -ge 250)) { Flush-RxLines -Force }

  # 2) commands: the engine renames a temp file into cmd/, we consume and delete it.
  if (($now - $lastScanAt) -ge $script:ScanMs) {
    $lastScanAt = $now
    $files = @(Get-ChildItem -LiteralPath $script:CmdDir -File -Filter '*.json' -ErrorAction SilentlyContinue | Sort-Object Name)
    foreach ($file in $files) {
      $command = Read-Json $file.FullName
      Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
      if ($null -eq $command) { continue }
      $lastCommandAt = $now
      $result = Invoke-BridgeCommand $command
      Write-Done ([string]$command.id) $result
      if (($result['ok'] -eq $true) -and ([string]$result['action'] -eq 'close')) {
        $running = $false
        $reason = 'requested'
        break
      }
    }
  }

  # 3) heartbeat: the engine reads status.json for counters and liveness.
  if (($now - $lastStatusAt) -ge 1000) {
    $lastStatusAt = $now
    Write-Status 'open' '' $null
  }

  # 4) orphan guard: the engine can be killed (window closed, host restart) while we are
  #    detached; without this the COM port would stay locked until reboot.
  if (($now - $lastParentCheck) -ge 5000) {
    $lastParentCheck = $now
    if (-not (Test-ParentAlive)) {
      Write-BridgeLog 'warn' 'parent process is gone; closing the port'
      $reason = 'parent-exit'
      $running = $false
      break
    }
  }

  # 5) idle guard: nobody talked to us for idleTimeoutMs (default 10 min) -> release the
  #    port so another tool (or the next session) can use it.
  if ($script:IdleTimeoutMs -gt 0 -and (($now - $lastCommandAt) -ge $script:IdleTimeoutMs)) {
    Write-BridgeLog 'warn' 'idle timeout; closing the port'
    $reason = 'idle'
    $running = $false
    break
  }

  Start-Sleep -Milliseconds 20
}

Flush-RxLines -Force
try {
  if ($script:Port.IsOpen) { $script:Port.Close() }
} catch {
  Write-BridgeLog 'warn' ('close failed: ' + [string]$_.Exception.Message)
}
Write-BridgeLog 'info' ('bridge stop reason=' + $reason)
Write-Status 'closed' $reason $null
try { $script:Port.Dispose() } catch { }
exit 0
