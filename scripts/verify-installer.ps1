$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$distRoot = Join-Path $repositoryRoot "dist"
$installers = @(Get-ChildItem -LiteralPath $distRoot -File -Filter "*.exe" | Where-Object { $_.Name -ne "Uninstall.exe" })
if ($installers.Count -ne 1) {
  throw "Expected exactly one installer in dist, found $($installers.Count)."
}

$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$testRoot = Join-Path $tempBase ("cloudflare-bot-deployer-verify-" + [Guid]::NewGuid().ToString("N"))
$CODEX_INSTALL_ROOT = Join-Path $testRoot "Custom Install Path"
$resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
if (-not $resolvedTestRoot.StartsWith($tempBase + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing an installer test path outside the temporary directory."
}
New-Item -ItemType Directory -Path $CODEX_INSTALL_ROOT -Force | Out-Null

try {
  $installer = $installers[0].FullName
  $installProcess = Start-Process -FilePath $installer -ArgumentList @("/S", "/D=$CODEX_INSTALL_ROOT") -Wait -PassThru -WindowStyle Hidden
  if ($installProcess.ExitCode -ne 0) { throw "Installer exited with code $($installProcess.ExitCode)." }

  $application = Join-Path $CODEX_INSTALL_ROOT "Cloudflare Telegram AI Bot Deployer.exe"
  $template = Join-Path $CODEX_INSTALL_ROOT "resources\template"
  $noticeEn = Join-Path $CODEX_INSTALL_ROOT "resources\DISCLAIMER.md"
  $noticeZh = Join-Path $CODEX_INSTALL_ROOT "resources\DISCLAIMER_ZH.md"
  foreach ($required in @($application, $template, $noticeEn, $noticeZh)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Packaged resource missing: $required" }
  }
  $uninstallers = @(Get-ChildItem -LiteralPath $CODEX_INSTALL_ROOT -File -Filter "Uninstall*.exe")
  if ($uninstallers.Count -ne 1) { throw "Expected exactly one Uninstall executable, found $($uninstallers.Count)." }
  $uninstaller = $uninstallers[0].FullName

  $smokeMarker = Join-Path $testRoot "smoke.txt"
  $smoke = Start-Process -FilePath $application -ArgumentList @("--smoke-test", "--smoke-test-output=$smokeMarker") -Wait -PassThru
  if ($smoke.ExitCode -ne 0) { throw "Packaged application smoke test exited with code $($smoke.ExitCode)." }
  if (-not (Test-Path -LiteralPath $smokeMarker) -or (Get-Content -LiteralPath $smokeMarker -Raw) -notmatch "main-window-ready") {
    throw "Packaged application did not report main-window-ready."
  }

  $hash = Get-FileHash -LiteralPath $installer -Algorithm SHA256
  "$($hash.Hash)  $($installers[0].Name)" | Set-Content -LiteralPath (Join-Path $distRoot "SHA256SUMS.txt") -Encoding ascii

  $uninstallProcess = Start-Process -FilePath $uninstaller -ArgumentList "/S" -Wait -PassThru -WindowStyle Hidden
  if ($uninstallProcess.ExitCode -ne 0) { throw "Uninstaller exited with code $($uninstallProcess.ExitCode)." }
  for ($attempt = 0; $attempt -lt 20 -and (Test-Path -LiteralPath $CODEX_INSTALL_ROOT); $attempt++) {
    Start-Sleep -Milliseconds 250
  }
  if (Test-Path -LiteralPath $CODEX_INSTALL_ROOT) { throw "Uninstall residue remains at the custom installation path." }
  Write-Output "installer-verification-passed"
}
finally {
  if (Test-Path -LiteralPath $testRoot) {
    $resolvedCleanup = [IO.Path]::GetFullPath($testRoot)
    if ($resolvedCleanup.StartsWith($tempBase + '\', [StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
  }
}
