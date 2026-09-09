$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'start.cmd'
$action    = New-ScheduledTaskAction -Execute $script
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'SocialSaverArchive' -Action $action `
    -Trigger $trigger -Settings $settings -Description 'Local social archive ingest server' -Force
Write-Output 'Registered scheduled task: SocialSaverArchive'
