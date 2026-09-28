$ErrorActionPreference = 'Stop'
Import-Module Pester -ErrorAction Stop
$repoRoot = Split-Path -Parent $PSScriptRoot
$r = Invoke-Pester -Script (Join-Path $repoRoot 'tests\switch.tests.ps1') -PassThru
$line = 'TOTAL=' + $r.TotalCount + ' PASSED=' + $r.PassedCount + ' FAILED=' + $r.FailedCount + ' SKIPPED=' + $r.SkippedCount
$resultPath = Join-Path $repoRoot 'pester-result.txt'
$line | Out-File -FilePath $resultPath -Encoding utf8
if ($r.FailedCount -gt 0) {
  $fails = $r.TestResult | Where-Object { $_.Result -eq 'Failed' }
  foreach ($f in $fails) {
    ('FAIL: ' + $f.Describe + ' / ' + $f.Name) | Out-File -FilePath $resultPath -Append -Encoding utf8
    ('   ' + $f.FailureMessage) | Out-File -FilePath $resultPath -Append -Encoding utf8
  }
  exit 1
}

