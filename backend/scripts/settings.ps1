function ConvertTo-BackendPort {
    param([string]$Value)

    [int]$port = 0
    if ($Value -notmatch '\A[0-9]+\z' -or
        -not [int]::TryParse($Value, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
        throw 'Enter a decimal port from 1 to 65535.'
    }
    return $port
}

function Write-BackendLocalFile {
    param([string]$StateDir, [string]$Name, [string]$Content)

    [void][IO.Directory]::CreateDirectory($StateDir)
    $path = Join-Path $StateDir $Name
    $temp = Join-Path $StateDir ([guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllText($temp, $Content)
        if ([IO.File]::Exists($path)) {
            [IO.File]::Replace($temp, $path, [System.Management.Automation.Language.NullString]::Value)
        } else {
            [IO.File]::Move($temp, $path)
        }
    } finally {
        [IO.File]::Delete($temp)
    }
}

function Get-BackendPort {
    param([string]$StateDir)

    $path = Join-Path $StateDir 'port.txt'
    if ([IO.File]::Exists($path)) {
        return ConvertTo-BackendPort ([IO.File]::ReadAllText($path).Trim())
    }
    return 5180
}

function Set-BackendPort {
    param([string]$StateDir, [string]$Value)

    $port = ConvertTo-BackendPort $Value
    Write-BackendLocalFile $StateDir 'port.txt' ([string]$port)
}

function Get-BackendConfiguredSettings {
    param([string]$ProjectDir)

    $configured = @{}
    $environment = $env:DOTNET_ENVIRONMENT
    if (-not $environment) { $environment = $env:ASPNETCORE_ENVIRONMENT }
    if (-not $environment) { $environment = 'Production' }

    foreach ($name in @('appsettings.json', "appsettings.$environment.json")) {
        $path = Join-Path $ProjectDir $name
        if (-not [IO.File]::Exists($path)) { continue }
        try {
            $json = [IO.File]::ReadAllText($path)
            # ASP.NET accepts comments and trailing commas. Preserve quoted strings verbatim.
            $quoted = '"(?:\\.|[^"\\])*"'
            $keepStrings = [Text.RegularExpressions.MatchEvaluator]{
                param($match)
                if ($match.Value.StartsWith('"')) { return $match.Value }
                return ' '
            }
            $json = [regex]::Replace($json, "$quoted|//[^\r\n]*|/\*[\s\S]*?\*/", $keepStrings)
            $json = [regex]::Replace($json, "$quoted|,(?=\s*[}\]])", $keepStrings)
            $settings = ConvertFrom-Json -InputObject $json -ErrorAction Stop
        } catch {
            throw "Unable to read configuration in $path. Check the file's JSON syntax."
        }

        foreach ($section in $settings.PSObject.Properties) {
            if ($section.Name -in 'ConnectionStrings', 'LedgerTokens') {
                if ($null -eq $section.Value) { continue }
                foreach ($property in $section.Value.PSObject.Properties) {
                    $configured["$($section.Name):$($property.Name)"] = -not [string]::IsNullOrWhiteSpace($property.Value)
                }
            } elseif ($section.Name -eq 'ConnectionStrings:Ledger' -or $section.Name -like 'LedgerTokens:*') {
                $configured[$section.Name] = -not [string]::IsNullOrWhiteSpace($section.Value)
            }
        }
    }
    return $configured
}

function Set-BackendSecretEnvironment {
    param([string]$StateDir, [string]$Name, [string]$FileName, [string]$Prompt)

    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw "Set $Name in the environment. Saving credentials requires Windows DPAPI."
    }
    $path = Join-Path $StateDir $FileName
    $saved = [IO.File]::Exists($path)
    if ($saved) {
        try {
            $secure = ConvertTo-SecureString ([IO.File]::ReadAllText($path)) -ErrorAction Stop
        } catch {
            throw "Cannot decrypt $path for this Windows user. Remove the file to enter a new value."
        }
    } else {
        $secure = Read-Host $Prompt -AsSecureString
    }
    try {
        $value = [Net.NetworkCredential]::new('', $secure).Password
        if ([string]::IsNullOrWhiteSpace($value)) {
            throw "$Name is required."
        }
        if ($Name -eq 'LedgerTokens__personal' -and $value -notmatch '\A[!-~]{32,1024}\z') {
            throw 'A ledger token must contain 32 to 1024 printable ASCII characters without spaces.'
        }
        if (-not $saved) {
            $ciphertext = ConvertFrom-SecureString $secure -ErrorAction Stop
            Write-BackendLocalFile $StateDir $FileName $ciphertext
        }
        [Environment]::SetEnvironmentVariable($Name, $value, 'Process')
    } finally {
        if ($secure) { $secure.Dispose() }
    }
}

function Initialize-BackendEnvironment {
    param([string]$StateDir, [string]$ProjectDir)

    $configured = Get-BackendConfiguredSettings $ProjectDir
    if (-not $env:ConnectionStrings__Ledger -and -not $configured['ConnectionStrings:Ledger']) {
        Set-BackendSecretEnvironment $StateDir 'ConnectionStrings__Ledger' 'connection.dpapi' 'PostgreSQL connection string'
    }
    $environmentTokens = @(Get-ChildItem Env:LedgerTokens__?* | Where-Object { $_.Value })
    $fileTokens = @($configured.Keys | Where-Object { $_ -like 'LedgerTokens:?*' -and $configured[$_] })
    if ($environmentTokens.Count -eq 0 -and $fileTokens.Count -eq 0) {
        Set-BackendSecretEnvironment $StateDir 'LedgerTokens__personal' 'personal-token.dpapi' 'Token for ledger personal (32-1024 printable ASCII characters without spaces)'
    }
}
