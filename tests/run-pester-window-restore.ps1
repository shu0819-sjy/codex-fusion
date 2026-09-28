$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$result = Invoke-Pester -Script (Join-Path $here 'window-restore.tests.ps1') -PassThru
$result | Select-Object -Property TotalCount, PassedCount, FailedCount, SkippedCount | Format-List
exit ([int]($result.FailedCount))
