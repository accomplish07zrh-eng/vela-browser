param(
    [string]$Workspace = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent),
    [ValidateRange(1, 32)][int]$Jobs = 2,
    [switch]$ConfigureOnly
)
$ErrorActionPreference = 'Stop'
$Workspace = (Resolve-Path -LiteralPath $Workspace).Path
$sourceRoot = Join-Path $Workspace 'reports\webkit-fingerprint-source'
$playwrightRoot = Join-Path $Workspace 'reports\playwright-webkit-source'
$buildRoot = Join-Path $Workspace 'reports\webkit-build\release'
$dependencyRoot = Join-Path $Workspace 'reports\webkit-build\vcpkg_installed'
$llvmRoot = Join-Path $Workspace 'reports\llvm-20.1.8\clang+llvm-20.1.8-x86_64-pc-windows-msvc\bin'
$visualStudioRoot = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools'
$cmake = Join-Path $visualStudioRoot 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
$ninja = Join-Path $visualStudioRoot 'Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja'
$vcpkgToolchain = Join-Path $visualStudioRoot 'VC\vcpkg\scripts\buildsystems\vcpkg.cmake'
$sourceCommit = (& git -C $sourceRoot rev-parse HEAD).Trim()
if ($sourceCommit -ne '5b391e6d3b14d549908dad2c6695999291313f30') { throw 'WebKit source revision does not match the audited baseline.' }
$playwrightCommit = (& git -C $playwrightRoot rev-parse HEAD).Trim()
if ($playwrightCommit -ne 'a1f35e1955976e84411f9c10358228a80b763ebe') { throw 'Playwright source revision does not match the audited baseline.' }
foreach ($path in @($sourceRoot, $dependencyRoot, $llvmRoot, $cmake, $vcpkgToolchain)) {
    if (!(Test-Path -LiteralPath $path)) { throw "Missing build prerequisite: $path" }
}
# Import only the compiler environment from the installed VS toolchain.
$devCommand = Join-Path $visualStudioRoot 'Common7\Tools\VsDevCmd.bat'
$compilerEnvironment = & $env:ComSpec /d /s /c "`"$devCommand`" -no_logo -arch=x64 -host_arch=x64 && set"
if ($LASTEXITCODE -ne 0) { throw 'Visual Studio compiler environment failed.' }
foreach ($line in $compilerEnvironment) {
    if ($line -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process') }
}
$env:PATH = "$llvmRoot;$ninja;C:\Program Files\Git\usr\bin;$env:PATH"
$env:X_VCPKG_REGISTRIES_CACHE = Join-Path $Workspace 'reports\webkit-build\registries'
$env:VCPKG_DOWNLOADS = Join-Path $Workspace 'reports\webkit-build\downloads'
$env:VCPKG_DEFAULT_BINARY_CACHE = Join-Path $Workspace 'reports\webkit-build\binary-cache'
$patch = Join-Path $PSScriptRoot 'patches\0001-saved-seed-canvas-fonts.patch'
$installedHeader = Join-Path $sourceRoot 'Source\WebCore\platform\VelaFingerprint.h'
if (!(Test-Path -LiteralPath $installedHeader)) {
    & git -C $sourceRoot apply --check $patch
    if ($LASTEXITCODE -ne 0) { throw 'Native fingerprint patch does not apply cleanly.' }
    & git -C $sourceRoot apply $patch
    if ($LASTEXITCODE -ne 0) { throw 'Native fingerprint patch failed.' }
}
$installedSource = [IO.File]::ReadAllText($installedHeader).Replace("`r`n", "`n").TrimEnd("`r", "`n")
$auditedSource = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'VelaFingerprint.h')).Replace("`r`n", "`n").TrimEnd("`r", "`n")
if ($installedSource -cne $auditedSource) {
    throw 'Installed seed implementation differs from the audited header.'
}
$embedder = Join-Path $sourceRoot 'Tools\Playwright'
New-Item -ItemType Directory -Path $embedder -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $playwrightRoot 'browser_patches\webkit\embedder\Playwright\win') -Destination $embedder -Recurse -Force
New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null
$arguments = @('-S', $sourceRoot, '-B', $buildRoot, '-G', 'Ninja',
    '-DPORT=Win', '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_C_COMPILER=clang-cl', '-DCMAKE_CXX_COMPILER=clang-cl',
    '-DCMAKE_LINKER=lld-link', "-DCMAKE_TOOLCHAIN_FILE=$vcpkgToolchain", "-DVCPKG_INSTALLED_DIR=$dependencyRoot",
    '-DVCPKG_TARGET_TRIPLET=x64-windows-webkit', '-DVCPKG_MANIFEST_MODE=OFF',
    '-DUSE_SKIA=ON', '-DUSE_CAIRO=OFF', '-DUSE_WOFF2=ON', '-DENABLE_MINIBROWSER=OFF',
    '-DENABLE_API_TESTS=OFF', '-DENABLE_LAYOUT_TESTS=OFF', '-DDEVELOPER_MODE=OFF', '-DENABLE_WEB_AUDIO=OFF')
& $cmake @arguments
if ($LASTEXITCODE -ne 0) { throw 'WebKit configure failed. The runtime has not been changed.' }
if (!$ConfigureOnly) {
    & $cmake --build $buildRoot --target Playwright --parallel $Jobs
    if ($LASTEXITCODE -ne 0) { throw 'WebKit build failed. The runtime has not been changed.' }
}
