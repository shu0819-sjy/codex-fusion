$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$result = Invoke-Pester -Script (Join-Path $here 'ensure-dream-skin.ps1.tests.ps1') -PassThru
$result | Select-Object -Property TotalCount, PassedCount, FailedCount, SkippedCount | Format-List
exit ([int]($result.FailedCount))
