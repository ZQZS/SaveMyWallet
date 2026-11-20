param(
    [ValidateSet('all', 'windows', 'android', 'web')]
    [string]$Target = 'all',
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$cliFile = Join-Path $projectRoot 'node_modules/@tauri-apps/cli/tauri.js'

function Invoke-Step([string]$Program, [string[]]$Arguments) {
    Write-Host "> $Program $($Arguments -join ' ')"
    & $Program @Arguments | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "$Program exited with code $LASTEXITCODE." }
}

function Import-BuildEnvironment {
    # An optional, untracked file locates nonstandard tool installations on this PC.
    $localFile = Join-Path $projectRoot '.tools/build-env.json'
    if (Test-Path -LiteralPath $localFile) {
        $settings = Get-Content -LiteralPath $localFile -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($key in @('CARGO_HOME', 'RUSTUP_HOME', 'JAVA_HOME', 'ANDROID_HOME', 'NDK_HOME', 'ANDROID_USER_HOME', 'GRADLE_USER_HOME', 'npm_config_cache')) {
            if ($settings.$key -and ![Environment]::GetEnvironmentVariable($key)) {
                $configuredPath = [Environment]::ExpandEnvironmentVariables($settings.$key)
                $absolutePath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($configuredPath)
                [Environment]::SetEnvironmentVariable($key, $absolutePath)
            }
        }
    }
    if ($env:CARGO_HOME) { $env:PATH = (Join-Path $env:CARGO_HOME 'bin') + ';' + $env:PATH }
}

function Find-AndroidTools {
    if (!$env:ANDROID_HOME) { $env:ANDROID_HOME = $env:ANDROID_SDK_ROOT }
    if (!$env:ANDROID_HOME) { $env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA 'Android/Sdk' }
    if (!(Test-Path -LiteralPath $env:ANDROID_HOME -PathType Container)) { throw 'Set ANDROID_HOME to your Android SDK directory.' }
    if (!$env:NDK_HOME) { $env:NDK_HOME = $env:ANDROID_NDK_HOME }
    if (!$env:NDK_HOME) {
        $ndk = Get-ChildItem -LiteralPath (Join-Path $env:ANDROID_HOME 'ndk') -Directory -ErrorAction SilentlyContinue |
            Where-Object { ($_.Name -as [version]) -and (Test-Path (Join-Path $_.FullName 'source.properties')) } |
            Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
        if ($ndk) { $env:NDK_HOME = $ndk.FullName }
    }
    if (!$env:NDK_HOME -or !(Test-Path -LiteralPath (Join-Path $env:NDK_HOME 'source.properties'))) { throw 'Set NDK_HOME to your installed Android NDK directory.' }
    if (!$env:JAVA_HOME -or !(Test-Path -LiteralPath (Join-Path $env:JAVA_HOME 'bin/javac.exe'))) { throw 'Set JAVA_HOME to a JDK (17 or later).' }
    $env:PATH = (Join-Path $env:JAVA_HOME 'bin') + ';' + $env:PATH
    $installed = & rustup.exe target list --installed
    if ($LASTEXITCODE -ne 0 -or $installed -notcontains 'aarch64-linux-android') { throw 'Install the Android Rust target with: rustup target add aarch64-linux-android' }
}

function Build-WindowsInstaller {
    $triple = 'x86_64-pc-windows-msvc'
    Invoke-Step node.exe @($cliFile, 'build', '--ci', '--bundles', 'nsis', '--target', $triple)
    return Join-Path $nativeTargetDir "$triple/release/bundle/nsis/${product}_${version}_x64-setup.exe"
}

function Publish-Artifact([string]$Source, [string]$Name) {
    if (!(Test-Path -LiteralPath $Source -PathType Leaf) -or (Get-Item -LiteralPath $Source).Length -eq 0) {
        throw "Build output missing: $Source"
    }
    # Write the complete file beside its destination before replacing a same-version package.
    $temporary = Join-Path $OutputDirectory ([IO.Path]::GetRandomFileName())
    $destination = Join-Path $OutputDirectory $Name
    try {
        [IO.File]::Copy($Source, $temporary)
        if ([IO.File]::Exists($destination)) { [IO.File]::Replace($temporary, $destination, [NullString]::Value) }
        else { [IO.File]::Move($temporary, $destination) }
        Write-Host "Built $destination"
    } finally {
        if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    }
}

$buildLock = $null
$logging = $false
Push-Location -LiteralPath $projectRoot
try {
    $toolsDir = Join-Path $projectRoot '.tools'
    [void][IO.Directory]::CreateDirectory($toolsDir)
    try {
        $buildLock = [IO.File]::Open((Join-Path $toolsDir 'build.lock'), 'OpenOrCreate', 'Write', 'None')
    } catch [IO.IOException] {
        throw "Cannot lock the build directory. Check whether another build is running in $projectRoot."
    }
    Start-Transcript -LiteralPath (Join-Path $toolsDir 'build.log') | Out-Null
    $logging = $true
    if (!$OutputDirectory) { $OutputDirectory = 'release' }
    $OutputDirectory = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputDirectory)
    Import-BuildEnvironment
    $null = Get-Command npm.cmd, node.exe -ErrorAction Stop
    if ($Target -ne 'web') {
        $null = Get-Command cargo.exe -ErrorAction Stop
        $metadata = & cargo.exe metadata --no-deps --format-version 1 --manifest-path src-tauri/Cargo.toml
        if ($LASTEXITCODE -ne 0) { throw 'Failed to read the Cargo target directory.' }
        $nativeTargetDir = ($metadata | ConvertFrom-Json).target_directory
        $env:CARGO_TARGET_DIR = $nativeTargetDir
    }
    if ($Target -in 'android', 'all') { Find-AndroidTools }

    Invoke-Step npm.cmd @('ci', '--include=dev', '--prefer-offline', '--no-audit', '--no-fund')
    Invoke-Step npm.cmd @('test')
    if ($Target -eq 'web') {
        Invoke-Step npm.cmd @('run', 'build')
        Write-Host "Built $(Join-Path $projectRoot 'dist')"
    } else {
        $config = Get-Content -LiteralPath 'src-tauri/tauri.conf.json' -Raw -Encoding UTF8 | ConvertFrom-Json
        $product = $config.productName
        $version = $config.version
        $artifacts = [ordered]@{}
        if ($Target -in 'windows', 'all') {
            $artifacts["$product-$version-Windows-x64-setup.exe"] = Build-WindowsInstaller
        }
        if ($Target -in 'android', 'all') {
            . (Join-Path $PSScriptRoot 'build-android.ps1')
            $artifacts["$product-$version-Android-arm64-debug.apk"] = Build-AndroidApk
        }
        [void][IO.Directory]::CreateDirectory($OutputDirectory)
        foreach ($fileName in $artifacts.Keys) { Publish-Artifact $artifacts[$fileName] $fileName }
    }
} catch {
    Write-Host ("Build failed: " + $_.Exception.Message) -ForegroundColor Red
    exit 1
} finally {
    if ($logging) { Stop-Transcript | Out-Null }
    if ($buildLock) { $buildLock.Dispose() }
    Pop-Location
}
