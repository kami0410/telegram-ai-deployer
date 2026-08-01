param(
  [ValidateSet('backup', 'restore')][string]$Mode = 'backup',
  [string]$Database = '',
  [string]$OutputDirectory = '',
  [string]$InputPath = '',
  [switch]$ConfirmEmptyDatabase
)

$secure = Read-Host 'Enter a backup passphrase (minimum 12 characters; it will not be saved)' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $env:PERSONA_BACKUP_PASSPHRASE = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  $arguments = @('tools/persona-backup.mjs', $Mode)
  if ($Database) { $arguments += @('--database', $Database) }
  if ($Mode -eq 'backup' -and $OutputDirectory) { $arguments += @('--output', $OutputDirectory) }
  if ($Mode -eq 'restore') {
    if (-not $InputPath) { throw 'Restore requires -InputPath.' }
    if (-not $ConfirmEmptyDatabase) { throw 'Restore is only allowed into a new empty database; add -ConfirmEmptyDatabase after checking the target.' }
    $arguments += @('--input', $InputPath, '--confirm-empty-database')
  }
  & node @arguments
  if ($LASTEXITCODE -ne 0) { throw "Backup tool failed with exit code $LASTEXITCODE." }
} finally {
  Remove-Item Env:PERSONA_BACKUP_PASSPHRASE -ErrorAction SilentlyContinue
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}
