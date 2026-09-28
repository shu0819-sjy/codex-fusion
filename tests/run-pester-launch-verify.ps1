$ErrorActionPreference = 'Stop'
Import-Module Pester -ErrorAction Stop
$r = Invoke-Pester -Script 'C:\codex-fusion\tests\launch-verify.tests.ps1' -PassThru
$out = 'C:\codex-fusion\pester-launch-verify.txt'
$line = 'TOTAL=' + $r.TotalCount + ' PASSED=' + $r.PassedCount + ' FAILED=' + $r.FailedCount + ' SKIPPED=' + $r.SkippedCount
$line | Out-File -FilePath $out -Encoding utf8
if ($r.FailedCount -gt 0) {
  $fails = $r.TestResult | Where-Object { $_.Result -eq 'Failed' }
  foreach ($f in $fails) {
    ('FAIL: ' + $f.Describe + ' / ' + $f.Name) | Out-File -FilePath $out -Append -Encoding utf8
    ('   ' + $f.FailureMessage) | Out-File -FilePath $out -Append -Encoding utf8
  }
}
