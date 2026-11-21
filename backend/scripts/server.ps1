[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Start', 'Stop', 'SetPort')]
    [string] $Action,
    [string] $Port
)

$ErrorActionPreference = 'Stop'
$backendDir = Split-Path $PSScriptRoot -Parent
$projectDir = Join-Path $backendDir 'SaveMyWallet.Api'
$exePath = Join-Path $projectDir 'bin\Release\net10.0\SaveMyWallet.Api.exe'
$stateDir = Join-Path $backendDir '.local'
$stateFile = Join-Path $stateDir 'server.json'
$launcherError = Join-Path $stateDir 'launch-error.tmp'
$stdoutLog = Join-Path $stateDir 'server.stdout.log'
$stderrLog = Join-Path $stateDir 'server.stderr.log'

function Enter-ControlLock {
    $lockPath = Join-Path $stateDir 'control.lock'
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while ($true) {
        try {
            return [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None')
        } catch [IO.IOException] {
            if (($_.Exception.HResult -band 65535) -notin 32, 33) { throw }
            if ($timer.Elapsed.TotalSeconds -ge 60) { throw 'Another backend command is still busy.' }
            Start-Sleep -Milliseconds 200
        }
    }
}

function Read-BackendRecord {
    try {
        $record = [IO.File]::ReadAllText($stateFile) | ConvertFrom-Json
        if (-not [IO.Path]::IsPathRooted([string]$record.Path) -or
            [string]$record.StartTimeUtcTicks -notmatch '^[1-9][0-9]{0,18}$' -or
            [int]$record.Pid -le 0 -or [int]$record.Port -lt 1 -or [int]$record.Port -gt 65535) {
            throw 'Invalid process identity.'
        }
        return $record
    } catch {
        throw "Cannot read the process record at $stateFile. Check for a running API before moving that file aside."
    }
}

function Get-ManagedProcess($record) {
    if ($record.Path -ne $exePath) { return }
    try {
        $candidate = [Diagnostics.Process]::GetProcessById([int]$record.Pid)
    } catch [ArgumentException] {
        return
    }
    # Hold a process handle while checking identity and stopping, even if the PID is recycled.
    try {
        $null = $candidate.Handle
        if (-not $candidate.HasExited -and
            $candidate.StartTime.ToUniversalTime().Ticks.ToString() -eq $record.StartTimeUtcTicks -and
            $candidate.MainModule.FileName -eq $exePath) {
            return $candidate
        }
    } catch [InvalidOperationException] {
        if (-not $candidate.HasExited) { throw }
    }
    $candidate.Dispose()
}

function Stop-ManagedProcess($process) {
    if (-not $process.HasExited) {
        try { $process.Kill() } catch [InvalidOperationException] {
            if (-not $process.HasExited) { throw }
        }
        if (-not $process.WaitForExit(10000)) { throw "Timed out stopping PID $($process.Id)." }
    }
}

function Test-ApiResponse([string]$url) {
    $request = [Net.HttpWebRequest]::Create("$url/sync/bootstrap")
    $request.Proxy = $null
    $request.AllowAutoRedirect = $false
    $request.KeepAlive = $false
    $request.Timeout = 800
    $response = $null
    try {
        $response = $request.GetResponse()
        return $false
    } catch [Net.WebException] {
        $response = $_.Exception.Response
        return $null -ne $response -and [int]$response.StatusCode -eq 401 -and
            $response.Headers['WWW-Authenticate'] -eq 'Bearer'
    } finally {
        if ($null -ne $response) { $response.Close() }
    }
}

function Wait-BackendReady($process, [int]$listenPort) {
    $url = "http://127.0.0.1:$listenPort"
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while ($timer.Elapsed.TotalSeconds -lt 45) {
        if ($process.HasExited) { throw "API exited with code $($process.ExitCode)." }
        if (Test-ApiResponse $url) {
            # Another HTTP service could win the port after our preflight check.
            $listener = "^\s*TCP\s+127\.0\.0\.1:$listenPort\s+0\.0\.0\.0:0\s+\S+\s+$($process.Id)\s*$"
            $rows = & "$env:SystemRoot\System32\netstat.exe" -ano -p tcp
            if (($rows -match $listener) -and -not $process.HasExited) { return }
        }
        Start-Sleep -Milliseconds 200
    }
    throw "Timed out waiting for $url."
}

function Start-AppHost([int]$listenPort) {
    $process = $null
    try {
        $process = Start-Process -FilePath $exePath -ArgumentList '--urls', "http://127.0.0.1:$listenPort" -WorkingDirectory $projectDir `
            -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
        $record = [ordered]@{
            Pid = $process.Id
            Path = $exePath
            StartTimeUtcTicks = $process.StartTime.ToUniversalTime().Ticks.ToString()
            Port = $listenPort
        }
        Write-BackendLocalFile $stateDir 'server.json' ($record | ConvertTo-Json)
    } catch {
        if ($null -ne $process) { Stop-ManagedProcess $process }
        [IO.File]::WriteAllText($launcherError, $_.Exception.Message)
        throw
    } finally {
        if ($null -ne $process) { $process.Dispose() }
    }
}

function Start-Backend([int]$listenPort) {
    $listeners = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    foreach ($endpoint in $listeners) {
        if ($endpoint.Port -eq $listenPort -and $endpoint.Address.ToString() -in '127.0.0.1', '0.0.0.0') {
            throw "Port $listenPort is already in use. Choose another port with set-port.cmd."
        }
    }
    Push-Location -LiteralPath $projectDir
    try {
        & dotnet build 'SaveMyWallet.Api.csproj' --configuration Release --nologo
        if ($LASTEXITCODE -ne 0) { throw "dotnet build failed (exit $LASTEXITCODE)." }
    } finally { Pop-Location }
    if (-not [IO.File]::Exists($exePath)) { throw "Build did not produce $exePath." }
    Initialize-BackendEnvironment -StateDir $stateDir -ProjectDir $projectDir

    $url = "http://127.0.0.1:$listenPort"
    $process = $null
    $launcher = $null
    try {
        [IO.File]::Delete($launcherError)
        # A separate console keeps the long-lived API from inheriting the caller's pipes.
        $arguments = '-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -Command ". ..\scripts\server.ps1 -Action Start; Start-AppHost {0}"' -f $listenPort
        $launcher = Start-Process -FilePath powershell.exe -ArgumentList $arguments -WorkingDirectory $projectDir -WindowStyle Hidden -PassThru
        $launcher.WaitForExit()
        if ($launcher.ExitCode -ne 0) {
            if ([IO.File]::Exists($launcherError)) { throw [IO.File]::ReadAllText($launcherError) }
            throw "API launcher exited with code $($launcher.ExitCode)."
        }
        $process = Get-ManagedProcess (Read-BackendRecord)
        if ($null -eq $process) {
            [IO.File]::Delete($stateFile)
            throw 'API exited during startup.'
        }
        Wait-BackendReady $process $listenPort
        Write-Host "Backend started at $url (PID $($process.Id))."
    } catch {
        $failure = $_.Exception.Message
        if ($null -ne $process) {
            Stop-ManagedProcess $process
            [IO.File]::Delete($stateFile)
        }
        throw "$failure See logs: $stdoutLog and $stderrLog"
    } finally {
        if ($null -ne $launcher) { $launcher.Dispose() }
        if ($null -ne $process) { $process.Dispose() }
        [IO.File]::Delete($launcherError)
    }
}

$lock = $null
$running = $null
try {
    . (Join-Path $PSScriptRoot 'settings.ps1')
    if ($MyInvocation.InvocationName -eq '.') { return }
    [void][IO.Directory]::CreateDirectory($stateDir)
    if ($Action -eq 'SetPort') {
        if ([string]::IsNullOrEmpty($Port)) { $Port = Read-Host 'HTTP port (1-65535)' }
        $Port = ([string]$Port).Trim()
        $lock = Enter-ControlLock
        Set-BackendPort -StateDir $stateDir -Value $Port
        Write-Host "Port $([int]$Port) saved. If the backend is running, stop and start it to apply."
    } else {
        $lock = Enter-ControlLock
        if ([IO.File]::Exists($stateFile)) {
            $record = Read-BackendRecord
            $running = Get-ManagedProcess $record
            if ($null -eq $running) { [IO.File]::Delete($stateFile) }
        }
        if ($Action -eq 'Stop') {
            if ($null -ne $running) {
                Stop-ManagedProcess $running
                [IO.File]::Delete($stateFile)
                Write-Host 'Backend stopped.'
            } else { Write-Host 'Backend is already stopped.' }
        } elseif ($null -ne $running) {
            try { Wait-BackendReady $running $record.Port } catch {
                throw "$($_.Exception.Message) See logs: $stdoutLog and $stderrLog"
            }
            Write-Host "Backend is already running at http://127.0.0.1:$($record.Port) (PID $($running.Id))."
        } else {
            Start-Backend (Get-BackendPort -StateDir $stateDir)
        }
    }
} catch {
    $message = $_.Exception.Message
    try {
        Write-BackendLocalFile $stateDir 'last-error.txt' $message
    } catch {
        # The original error still matters if the state directory is inaccessible.
    }
    [Console]::Error.WriteLine($message)
    exit 1
} finally {
    if ($null -ne $running) { $running.Dispose() }
    if ($null -ne $lock) { $lock.Dispose() }
}
exit 0
