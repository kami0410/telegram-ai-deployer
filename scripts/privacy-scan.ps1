$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$scanRoot = Join-Path $tempBase ("cloudflare-bot-privacy-" + [Guid]::NewGuid().ToString("N"))
$generatedRoot = Join-Path $scanRoot "generated"
$asarRoot = Join-Path $scanRoot "app-asar"
$forbidden = '(yuan|kami|ns1[.]dnshe[.]com|tavilyApiKey=|tvly-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{16,}|[0-9]{6,12}:[A-Za-z0-9_-]{30,}|https?://[a-z0-9.-]+[.]workers\.dev|codex-clipboard-[a-f0-9-]{20,})'
$excludedPaths = @(
  ':(exclude)scripts/privacy-scan.ps1',
  ':(exclude)test/privacy-gate.test.mjs',
  ':(exclude)test/template-privacy.test.mjs',
  ':(exclude)test/cloudflare.test.mjs'
)

function Assert-GitScopeClean {
  param([string]$Commit)
  & git grep -I -i -q -E $forbidden $Commit -- . @excludedPaths
  if ($LASTEXITCODE -eq 0) { throw "Privacy scan detected forbidden content in a Git scope." }
  if ($LASTEXITCODE -ne 1) { throw "Git privacy scan failed to execute." }
}

function Assert-DirectoryClean {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return }
  & rg --files-with-matches --hidden --no-messages -I -i -e $forbidden --glob '!node_modules/**' --glob '!dist/**' --glob '!.git/**' --glob '!scripts/privacy-scan.ps1' --glob '!test/privacy-gate.test.mjs' --glob '!test/template-privacy.test.mjs' --glob '!test/cloudflare.test.mjs' $Path | Out-Null
  if ($LASTEXITCODE -eq 0) { throw "Privacy scan detected forbidden content in a filesystem scope." }
  if ($LASTEXITCODE -ne 1) { throw "Filesystem privacy scan failed to execute." }
}

Push-Location $repositoryRoot
try {
  Assert-DirectoryClean -Path $repositoryRoot
  $commits = @(& git rev-list --all)
  if ($LASTEXITCODE -ne 0) { throw "git rev-list failed." }
  foreach ($commit in $commits) { Assert-GitScopeClean -Commit $commit }

  New-Item -ItemType Directory -Path $scanRoot -Force | Out-Null
  & node (Join-Path $PSScriptRoot "generate-privacy-fixture.mjs") $generatedRoot
  if ($LASTEXITCODE -ne 0) { throw "Privacy fixture generation failed." }
  Assert-DirectoryClean -Path $generatedRoot

  $asarPath = Join-Path $repositoryRoot "dist\win-unpacked\resources\app.asar"
  if (Test-Path -LiteralPath $asarPath) {
    & npx.cmd --no-install asar extract $asarPath $asarRoot
    if ($LASTEXITCODE -ne 0) { throw "app.asar extraction failed." }
    Assert-DirectoryClean -Path $asarRoot
    Assert-DirectoryClean -Path (Join-Path $repositoryRoot "dist\win-unpacked\resources\template")
  }
  Write-Output "privacy-scan-passed"
}
finally {
  Pop-Location
  if (Test-Path -LiteralPath $scanRoot) {
    $resolvedCleanup = [IO.Path]::GetFullPath($scanRoot)
    if ($resolvedCleanup.StartsWith($tempBase + '\', [StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $scanRoot -Recurse -Force
    }
  }
}
