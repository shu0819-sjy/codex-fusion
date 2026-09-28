# Ensure every PowerShell script under the fusion root is UTF-8 WITH BOM.
# Why: Windows PowerShell 5.1 decodes BOM-less files as ANSI, which mangles non-ASCII text
# and can even hang the parser. Writing with an explicit BOM removes that whole class of failure.
$ErrorActionPreference = 'Stop'
$root = 'C:\codex-fusion'
$utf8Strict = New-Object System.Text.UTF8Encoding($false, $true)
$added = 0
$skipped = 0
$bad = 0

$files = Get-ChildItem -LiteralPath $root -Recurse -File -Filter *.ps1 -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -notmatch '\\(node_modules|third_party|target|dist)\\' }

foreach ($file in $files) {
  $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
  if ($bytes.Length -eq 0) { continue }
  $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  if ($hasBom) { $skipped++; continue }
  # Only rewrite when the bytes are valid UTF-8; otherwise leave the file untouched and report it.
  try {
    $text = $utf8Strict.GetString($bytes)
  } catch {
    "NOT-UTF8 (left untouched): $($file.FullName)"
    $bad++
    continue
  }
  [System.IO.File]::WriteAllText($file.FullName, $text, (New-Object System.Text.UTF8Encoding($true)))
  "BOM added: $($file.FullName)"
  $added++
}

""
"files=$($files.Count) addedBom=$added alreadyHadBom=$skipped notUtf8=$bad"
