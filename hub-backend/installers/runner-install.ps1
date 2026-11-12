<#
Install the SoduWork Runner on Windows, write device configuration, and register a
scheduled startup task. The setup command supplies credentials through -Key; no
credentials are embedded in this downloadable script.

Example:
  .\runner-install.ps1 -Hub http://192.0.2.40:9080 -Id rn-xxx -Key <key> -Tags win,intranet
Uninstall:
  .\runner-install.ps1 -Uninstall
#>
param(
    [string]$Hub = '',
    [string]$Id = '',
    [string]$Key = '',
    [string]$Tags = '',
    [string]$Root = '',
    [string]$WorkRoot = '',
    [switch]$AsSystem,
    [switch]$NoService,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Suppress download progress to avoid flooding the console.
$TaskName = 'SoduWorkRunner'

function Say([string]$m) { Write-Host $m }
function Die([string]$m) { Write-Host ("装机没成：" + $m) -ForegroundColor Red; exit 1 }

$isAdmin = ([Security.Principal.WindowsPrincipal] `
        [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $Root) {
    # Administrators install under ProgramData; ordinary users install in their own profile.
    $Root = if ($isAdmin) { Join-Path $env:ProgramData 'SoduWork\runner' }
    else { Join-Path $env:LOCALAPPDATA 'SoduWork\runner' }
}
$AppDir = Join-Path $Root 'app'
$Exe = Join-Path $AppDir 'soduwork-runner.exe'
$Cfg = Join-Path $Root 'runner.json'

function Stop-RunnerTask {
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($t) {
        try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
    }
    # A stopped scheduled task may still be finishing work; wait for the executable to be released.
    # Stop legacy soduwork-runner processes as well during upgrades.
    for ($i = 0; $i -lt 10; $i++) {
        $p = Get-Process -Name 'soduwork-runner', 'soduwork-runner' -ErrorAction SilentlyContinue
        if (-not $p) { break }
        Start-Sleep -Seconds 1
        if ($i -ge 6) { $p | Stop-Process -Force -ErrorAction SilentlyContinue }
    }
}

if ($Uninstall) {
    Stop-RunnerTask
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
    Say "已停掉并取消常驻。程序还在 $Root（工作目录和日志都在里面），确认不用了自己删。"
    Say "钥匙请到管理端「执行机与钥匙」里吊销，那才是真的断开。"
    exit 0
}

if (-not $Hub) { Die '缺 -Hub（后端地址，如 http://192.0.2.40:9080）' }
if (-not $Id) { Die '缺 -Id（执行机 id，管理端发钥时给的）' }
$Hub = $Hub.TrimEnd('/')

# Download the installation package.
Say "① 从 $Hub 下载执行机安装包…"
$tmp = Join-Path $env:TEMP ("soduwork-runner-" + [guid]::NewGuid().ToString('N') + ".zip")
try {
    Invoke-WebRequest -Uri ($Hub + '/api/v1/download/runner?os=win') -OutFile $tmp -UseBasicParsing
}
catch {
    Die ("下不到安装包（" + $_.Exception.Message + "）。先确认这台机器能打开 $Hub 。")
}
$sizeMb = [math]::Round((Get-Item $tmp).Length / 1MB, 1)
if ($sizeMb -lt 1) { Die "下下来的包只有 $sizeMb MB，不像是完整的包（后端可能还没放包）。" }

Stop-RunnerTask
New-Item -ItemType Directory -Force -Path $Root | Out-Null
if (Test-Path -LiteralPath $AppDir) { Remove-Item -Recurse -Force $AppDir }
Say "② 解包到 $AppDir （$sizeMb MB）…"
Expand-Archive -LiteralPath $tmp -DestinationPath $AppDir -Force
Remove-Item -Force $tmp -ErrorAction SilentlyContinue
if (-not (Test-Path -LiteralPath $Exe)) { Die "包里没有 soduwork-runner.exe" }

# Write this device's configuration.
# Reuse the existing key when an upgrade omits -Key.
if (-not $Key -and (Test-Path -LiteralPath $Cfg)) {
    try { $Key = (Get-Content -Raw -LiteralPath $Cfg | ConvertFrom-Json).key } catch {}
}
if (-not $Key) { Die '缺 -Key（这台机器的专属钥匙，管理端发钥时只显示一次）' }
if (-not $WorkRoot) { $WorkRoot = Join-Path $Root 'work' }
$dataRoot = Join-Path $Root 'data'
New-Item -ItemType Directory -Force -Path $WorkRoot, $dataRoot | Out-Null
$tagList = @()
if ($Tags) { $tagList = @($Tags -split '[,\s]+' | Where-Object { $_ }) }
$json = @{
    hub      = $Hub
    runnerId = $Id
    key      = $Key
    tags     = $tagList
    workRoot = $WorkRoot
    dataRoot = $dataRoot
} | ConvertTo-Json
# Avoid Set-Content -Encoding UTF8 because Windows PowerShell 5.1 adds a BOM.
# Python json.load rejects that BOM with JSONDecodeError.
# The scheduled task can therefore exist while its process fails to start.
[IO.File]::WriteAllText($Cfg, $json, (New-Object Text.UTF8Encoding($false)))
Say "③ 配置写好了：$Cfg"

# Register the persistent Runner task.
if ($NoService) {
    Say "④ 按要求没注册常驻。要手动跑："
    Say "   `"$Exe`" --config `"$Cfg`""
    exit 0
}
# Preserve the installer's PATH so user-installed codex, pi, and opencode CLIs remain discoverable.
# Service accounts do not normally include user npm directories in PATH.
# A Runner with no discovered CLIs may appear online but cannot receive AI work.
$launcher = Join-Path $Root 'run.cmd'
$launchText = "@echo off`r`nset `"PATH=$env:PATH`"`r`ncd /d `"$AppDir`"`r`n`"$Exe`" --config `"$Cfg`"`r`n"
[IO.File]::WriteAllText($launcher, $launchText, (New-Object Text.UTF8Encoding($false)))

$action = New-ScheduledTaskAction -Execute $launcher -WorkingDirectory $AppDir
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
if ($isAdmin -and -not $AsSystem) {
    # By default, start at boot as the installing user through S4U without storing a password.
    # This exposes user CLIs and login state; -AsSystem explicitly selects the service identity.
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId ("$env:USERDOMAIN\$env:USERNAME") `
        -LogonType S4U -RunLevel Highest
}
elseif ($isAdmin) {
    # SYSTEM runs independently at boot but cannot normally access user-installed CLIs.
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
}
else {
    # Without administrator rights, start at user logon within that user's session.
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User ("$env:USERDOMAIN\$env:USERNAME")
    $principal = New-ScheduledTaskPrincipal -UserId ("$env:USERDOMAIN\$env:USERNAME") -LogonType Interactive
}
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
$desc = 'SoduWork 执行机：接后端派来的活（AI 改代码、部署、终端）'
try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings -Description $desc | Out-Null
}
catch {
    # If account policy prevents S4U registration, fall back to the service identity.
    Say "   以你的身份注册不了（$($_.Exception.Message)），退回 SYSTEM 身份。"
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings -Description $desc | Out-Null
}
Start-ScheduledTask -TaskName $TaskName
Say ("④ 已注册常驻计划任务 $TaskName 并启动（身份：" + $principal.UserId + "）。")

Start-Sleep -Seconds 4
# Match the executable path because the desktop client may run another bundled Runner.
# Process-name matching alone could mistake another installation for this one.
$proc = Get-Process -Name 'soduwork-runner', 'soduwork-runner' -ErrorAction SilentlyContinue |
Where-Object { $_.Path -eq $Exe } | Select-Object -First 1
if ($proc) {
    Say ""
    Say ("装好了：执行机 $Id 正在跑（PID " + $proc.Id + "）。")
}
else {
    Say ""
    Say "计划任务已建，但没看到进程在跑。自己跑一下看报什么："
    Say "   `"$Exe`" --config `"$Cfg`""
}
if (-not $isAdmin) {
    Say "注意：这次是**普通用户**装的，只有你登录着它才在。要开机常驻，用管理员再跑一遍这条命令。"
}
Say "去管理端「执行机与钥匙」里看它是不是上线了（$Hub）。"
