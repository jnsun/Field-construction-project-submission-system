$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\tools\d03-cross-schema-application-objects.ps1')

$sql = Get-D03CanonicalAuthUserProfileTriggerSql
if ($sql -notmatch 'DROP TRIGGER IF EXISTS on_auth_user_created ON auth\.users;' -or $sql -notmatch 'FOR EACH ROW EXECUTE FUNCTION public\.handle_new_user\(\);') {
  throw 'Canonical cross-schema trigger extraction failed.'
}

$probeSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\tools\d03-cross-schema-application-objects.ps1') -Raw
$expectedTestHash = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy'
if ($probeSource -notmatch [regex]::Escape($expectedTestHash)) {
  throw 'Cross-schema anonymous-user probe must use its fixed non-production test hash.'
}

'D03 cross-schema application object source test passed.'
