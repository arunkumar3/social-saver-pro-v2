$ErrorActionPreference = 'Stop'

$script = Join-Path $PSScriptRoot 'start.cmd'
if (-not (Test-Path $script)) { throw "start.cmd not found at $script" }

# -Execute is a PATH field in the task XML, not a command line. Do NOT wrap it
# in quotes: Task Scheduler would treat the quote characters as part of the
# filename. Spaces in the path are handled by the XML element itself.
$action = New-ScheduledTaskAction -Execute $script

# Task Scheduler needs a QUALIFIED principal (DOMAIN\user or MACHINE\user).
# A bare $env:USERNAME is rejected with "The parameter is incorrect."
# GetCurrent().Name yields the qualified form on both domain and local accounts.
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$trigger   = New-ScheduledTaskTrigger -AtLogOn

# ExecutionTimeLimit of zero means "no limit". Without it Windows kills the
# task after three days and the archive silently stops accepting saves.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName 'SocialSaverArchive' -Action $action `
    -Trigger $trigger -Principal $principal -Settings $settings `
    -Description 'Local social archive ingest server' -Force | Out-Null

Write-Output "Registered scheduled task 'SocialSaverArchive' for $userId"
Write-Output "To remove it:  Unregister-ScheduledTask -TaskName 'SocialSaverArchive' -Confirm:`$false"
