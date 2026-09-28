$ErrorActionPreference = 'Stop'
Import-Module Pester -ErrorAction Stop
$r = Invoke-Pester -Script '.\tests\switch.tests.ps1' -PassThru
$line = 'TOTAL=' + $r.TotalCount + ' PASSED=' + $r.PassedCount + ' FAILED=' + $r.FailedCount + ' SKIPPED=' + $r.SkippedCount
$line | Out-File -FilePath 'C:\codex-fusion\pester-result.txt' -Encoding utf8
if ($r.FailedCount -gt 0) {
  $fails = $r.TestResult | Where-Object { $_.Result -eq 'Failed' }
  foreach ($f in $fails) {
    ('FAIL: ' + $f.Describe + ' / ' + $f.Name) | Out-File -FilePath 'C:\codex-fusion\pester-result.txt' -Append -Encoding utf8
    ('   ' + $f.FailureMessage) | Out-File -FilePath 'C:\codex-fusion\pester-result.txt' -Append -Encoding utf8
  }
}
