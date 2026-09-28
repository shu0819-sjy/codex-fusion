$ErrorActionPreference = 'Stop'
Import-Module Pester -ErrorAction Stop
$r = Invoke-Pester -Script 'D:\CodexFusion\tests\session-claim.tests.ps1' -PassThru
$out = 'D:\CodexFusion\pester-session-claim.txt'
$lines = @()
$lines += 'TOTAL=' + $r.TotalCount + ' PASSED=' + $r.PassedCount + ' FAILED=' + $r.FailedCount + ' SKIPPED=' + $r.SkippedCount
foreach ($t in $r.TestResult) {
  $lines += ($t.Result + ' | ' + $t.Describe + ' | ' + $t.Name)
}
[System.IO.File]::WriteAllLines($out, $lines, (New-Object System.Text.UTF8Encoding($true)))
$lines -join "`n"
if ($r.FailedCount -gt 0) {
  foreach ($f in ($r.TestResult | Where-Object { $_.Result -eq 'Failed' })) {
    'FAILMSG: ' + $f.Name
    '   ' + $f.FailureMessage
  }
  exit 1
}
exit 0
