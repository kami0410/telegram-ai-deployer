$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$scanRoot = Join-Path $tempBase ("cloudflare-bot-privacy-" + [Guid]::NewGuid().ToString("N"))
$generatedRoot = Join-Path $scanRoot "generated"
$asarRoot = Join-Path $scanRoot "app-asar"
$forbidden = '(yuan|kami|ns1[.]dnshe[.]com|tavilyApiKey=|tvly-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{16,}|[0-9]{6,12}:[A-Za-z0-9_-]{30,}|https?://[a-z0-9.-]+[.]workers[.]dev|codex-clipboard-[a-f0-9-]{20,}|[A-Za-z]:\\Users\\[^\\[:space:]]+)'
$excludedPaths = @(
  ':(exclude)scripts/privacy-scan.ps1',
  ':(exclude)scripts/privacy-rules.mjs',
  ':(exclude)test/privacy-gate.test.mjs',
  ':(exclude)test/template-privacy.test.mjs',
  ':(exclude)test/cloudflare.test.mjs',
  ':(exclude)package-lock.json',
  ':(exclude)template/package-lock.json',
  ':(exclude)template/vitest.config.ts'
)

function Assert-GitScopeClean {
  param([string]$Commit)
  & git grep -I -i -q -E $forbidden $Commit -- . @excludedPaths
  if ($LASTEXITCODE -eq 0) { throw "Privacy scan detected forbidden content in a Git scope." }
  if ($LASTEXITCODE -ne 1) { throw "Git privacy scan failed to execute." }
}

function Assert-GitStructuredClean {
  param([string]$Commit)
  $uuid = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}'
  $uuidLines = @(& git grep -I -h -E $uuid $Commit -- . @excludedPaths)
  foreach ($line in $uuidLines) {
    foreach ($match in [regex]::Matches($line, $uuid)) {
      if ($match.Value -ne '00000000-0000-0000-0000-000000000000') { throw "Git history contains a non-placeholder UUID." }
    }
  }
  $email = '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}'
  $emailLines = @(& git grep -I -h -E $email $Commit -- . @excludedPaths)
  foreach ($line in $emailLines) {
    foreach ($match in [regex]::Matches($line, $email)) {
      $domain = $match.Value.Split('@')[-1].ToLowerInvariant()
      if ($domain -notin @('example.invalid', 'example.com')) { throw "Git history contains a non-example email." }
    }
  }
  $secretAssignment = '(TOKEN|API_KEY|SECRET)[[:space:]]*[:=][[:space:]]*["''][A-Za-z0-9_-]{16,}'
  $secretLines = @(& git grep -I -h -i -E $secretAssignment $Commit -- . @excludedPaths)
  $secretDotNet = '(TOKEN|API_KEY|SECRET)\s*[:=]\s*["'']([A-Za-z0-9_-]{16,})'
  $reviewedFixtureSecrets = @('test-only-telegram-token', 'test-only-deepseek-key', 'test-only-webhook-secret', 'example-telegram-token-that-is-not-valid')
  foreach ($line in $secretLines) {
    foreach ($match in [regex]::Matches($line, $secretDotNet, [Text.RegularExpressions.RegexOptions]::IgnoreCase)) {
      if ($match.Groups[2].Value -notin $reviewedFixtureSecrets) { throw "Git history contains a literal secret assignment." }
    }
  }
  $paths = @(& git ls-tree -r --name-only $Commit)
  if ($paths | Where-Object { $_ -match '(?i)chat[_ -]?export|\.(bmp|gif|ico|jpe?g|png|webp)$' }) {
    throw "Git history contains an unreviewed chat export or image asset."
  }
}

function Assert-DirectoryClean {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return }
  & rg --files-with-matches --hidden --no-messages -I -i -e $forbidden --glob '!**/node_modules/**' --glob '!**/dist/**' --glob '!**/.git/**' --glob '!scripts/privacy-scan.ps1' --glob '!scripts/privacy-rules.mjs' --glob '!test/privacy-gate.test.mjs' --glob '!test/template-privacy.test.mjs' --glob '!test/cloudflare.test.mjs' $Path | Out-Null
  if ($LASTEXITCODE -eq 0) { throw "Privacy scan detected forbidden content in a filesystem scope." }
  if ($LASTEXITCODE -ne 1) { throw "Filesystem privacy scan failed to execute." }
}

Push-Location $repositoryRoot
try {
  Assert-DirectoryClean -Path $repositoryRoot
  & node (Join-Path $PSScriptRoot "privacy-rules.mjs") $repositoryRoot
  if ($LASTEXITCODE -ne 0) { throw "Structured privacy rules failed for the worktree." }
  $commits = @(& git rev-list --all)
  if ($LASTEXITCODE -ne 0) { throw "git rev-list failed." }
  foreach ($commit in $commits) {
    Assert-GitScopeClean -Commit $commit
    Assert-GitStructuredClean -Commit $commit
  }

  New-Item -ItemType Directory -Path $scanRoot -Force | Out-Null
  & node (Join-Path $PSScriptRoot "generate-privacy-fixture.mjs") $generatedRoot
  if ($LASTEXITCODE -ne 0) { throw "Privacy fixture generation failed." }
  Assert-DirectoryClean -Path $generatedRoot
  & node (Join-Path $PSScriptRoot "privacy-rules.mjs") $generatedRoot
  if ($LASTEXITCODE -ne 0) { throw "Structured privacy rules failed for generated output." }

  $asarPath = Join-Path $repositoryRoot "dist\win-unpacked\resources\app.asar"
  if (Test-Path -LiteralPath $asarPath) {
    & npx.cmd --no-install asar extract $asarPath $asarRoot
    if ($LASTEXITCODE -ne 0) { throw "app.asar extraction failed." }
    Assert-DirectoryClean -Path $asarRoot
    & node (Join-Path $PSScriptRoot "privacy-rules.mjs") $asarRoot
    if ($LASTEXITCODE -ne 0) { throw "Structured privacy rules failed for app.asar." }
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
