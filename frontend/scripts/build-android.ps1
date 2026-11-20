# The caller supplies projectRoot, cliFile, nativeTargetDir and Invoke-Step.
function Build-AndroidApk {
    $androidDir = Join-Path $projectRoot 'src-tauri/gen/android'
    $library = 'libsave_my_wallet_lib.so'
    $nativeLibrary = Join-Path $nativeTargetDir "aarch64-linux-android/debug/$library"
    $jniDir = Join-Path $androidDir 'app/src/main/jniLibs/arm64-v8a'
    $stagedLibrary = Join-Path $jniDir $library
    $llvmBin = Join-Path $env:NDK_HOME 'toolchains/llvm/prebuilt/windows-x86_64/bin'

    # NDK versions before r28 need an explicit 16 KiB ELF page size. Scope
    # this to the Android build and preserve flags supplied by the developer.
    $ndkProperties = Get-Content -LiteralPath (Join-Path $env:NDK_HOME 'source.properties') -Raw
    if ($ndkProperties -notmatch '(?m)^Pkg\.Revision\s*=\s*(\d+)') {
        throw "Cannot determine the NDK version in $env:NDK_HOME"
    }
    $needsPageFlag = [int]$Matches[1] -lt 28
    $oldFlags = $env:RUSTFLAGS
    $oldEncoded = $env:CARGO_ENCODED_RUSTFLAGS
    $finishedCargo = $false
    $linkingArm64 = $false
    $failedLink = $false
    $missingPrivilege = $false
    try {
        if ($needsPageFlag) {
            $pageFlag = '-Clink-arg=-Wl,-z,max-page-size=16384'
            if ($oldEncoded) {
                $env:CARGO_ENCODED_RUSTFLAGS = $oldEncoded + [char]31 + $pageFlag
            } else {
                $flags = if ($oldFlags) { $oldFlags } else { $env:CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS }
                $env:RUSTFLAGS = ("$flags $pageFlag").Trim()
            }
        }

        # Windows PowerShell 5.1 represents redirected native stderr as
        # ErrorRecords. Use the process exit code and inspect its actual output.
        $previousPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            & node.exe $cliFile android build --ci --apk --debug --target aarch64 --split-per-abi 2>&1 | ForEach-Object {
                $line = $_.ToString() -replace '\x1B\[[0-9;]*m', ''
                Write-Host $line
                if ($line -match 'Finished\s+[`'']dev[`''] profile') { $finishedCargo = $true }
                if ($line -match 'symlinking lib.*libsave_my_wallet_lib\.so.*arm64-v8a') { $linkingArm64 = $true }
                if ($line -match 'Failed to create a symbolic link.*libsave_my_wallet_lib\.so') { $failedLink = $true }
                if ($line -match 'Creation symbolic link is not allowed for this system|os error 1314\b') { $missingPrivilege = $true }
            }
            $tauriExit = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousPreference
        }
    } finally {
        $env:RUSTFLAGS = $oldFlags
        $env:CARGO_ENCODED_RUSTFLAGS = $oldEncoded
    }

    if ($tauriExit -ne 0) {
        if (-not ($finishedCargo -and $linkingArm64 -and $failedLink -and $missingPrivilege)) {
            throw "Tauri Android build failed (exit $tauriExit)."
        }
        if (-not (Test-Path -LiteralPath $nativeLibrary -PathType Leaf)) {
            throw "Cargo finished but its arm64 library was not found at $nativeLibrary"
        }
        Write-Host 'Windows denied the JNI symbolic link. Packaging the freshly built arm64 library with Gradle.'
        [void][IO.Directory]::CreateDirectory($jniDir)
        $existing = Get-Item -LiteralPath $stagedLibrary -Force -ErrorAction SilentlyContinue
        if ($existing -and ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Cannot stage the native library over a reparse point: $stagedLibrary"
        }
        Invoke-Step (Join-Path $llvmBin 'llvm-strip.exe') @('--strip-debug', '-o', $stagedLibrary, $nativeLibrary) | Out-Host
        Push-Location -LiteralPath $androidDir
        try {
            Invoke-Step (Join-Path $androidDir 'gradlew.bat') @(
                ':app:assembleArm64Debug', '-x', ':app:rustBuildArm64Debug',
                '-PabiList=arm64-v8a', '-ParchList=arm64', '-PtargetList=aarch64'
            ) | Out-Host
        } finally {
            Pop-Location
        }
    }

    $programHeaders = & (Join-Path $llvmBin 'llvm-readelf.exe') -lW $stagedLibrary
    $loadSegments = @($programHeaders | Where-Object { $_ -match '^\s*LOAD\s' })
    if ($LASTEXITCODE -ne 0 -or $loadSegments.Count -eq 0) {
        throw "Cannot read ELF load segments from $stagedLibrary"
    }
    foreach ($segment in $loadSegments) {
        if ($segment -notmatch '0x([0-9a-f]+)\s*$' -or [Convert]::ToInt64($Matches[1], 16) -lt 16384) {
            throw 'The arm64 ELF does not meet Android 16 KiB page alignment.'
        }
    }

    $apkDir = Join-Path $androidDir 'app/build/outputs/apk/arm64/debug'
    $metadata = Get-Content -LiteralPath (Join-Path $apkDir 'output-metadata.json') -Raw | ConvertFrom-Json
    $artifact = @($metadata.elements)
    if ($metadata.variantName -ne 'arm64Debug' -or $artifact.Count -ne 1 -or
        $artifact[0].versionName -ne $version -or $artifact[0].outputFile -ne 'app-arm64-debug.apk') {
        throw "Unexpected APK output metadata in $apkDir"
    }
    $apk = Join-Path $apkDir 'app-arm64-debug.apk'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($apk)
    try {
        $entry = $archive.GetEntry("lib/arm64-v8a/$library")
        $otherAbis = @($archive.Entries | Where-Object { $_.FullName -match '^lib/(?!arm64-v8a/)[^/]+/' })
        if (-not $archive.GetEntry('AndroidManifest.xml') -or -not $entry -or $otherAbis.Count) {
            throw "Invalid Android manifest or unexpected ABI in $apk"
        }
        # This project keeps arm64 debug symbols in Gradle. Comparing bytes
        # catches a stale APK left over from another invocation or checkout.
        $embeddedStream = $entry.Open()
        $builtStream = [IO.File]::OpenRead($stagedLibrary)
        $sha = [Security.Cryptography.SHA256]::Create()
        try {
            if ([BitConverter]::ToString($sha.ComputeHash($embeddedStream)) -ne [BitConverter]::ToString($sha.ComputeHash($builtStream))) {
                throw 'The APK contains a different native library from the current build.'
            }
        } finally {
            $sha.Dispose()
            $builtStream.Dispose()
            $embeddedStream.Dispose()
        }
    } finally {
        $archive.Dispose()
    }
    return $apk
}
