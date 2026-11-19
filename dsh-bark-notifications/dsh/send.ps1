$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
$phase = 'credential'
$bytes = $null
try {
    Add-Type -AssemblyName System.Security
    $path = Join-Path $env:LOCALAPPDATA 'DSHBark\device-key.dpapi'
    $encrypted = [IO.File]::ReadAllBytes($path)
    $bytes = [Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    $key = [Text.Encoding]::UTF8.GetString($bytes)
    if ([string]::IsNullOrWhiteSpace($key)) { throw 'missing' }
    $n = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if (-not $n.session_title -or -not $n.reply_preview) { throw 'missing_notification' }
    $phase = 'send'
    # The title already carries `｜device`; never append it twice.
    $pipe = [string][char]0xFF5C
    $title = if ([string]$n.session_title -like ('*' + $pipe + '*')) { [string]$n.session_title } else { [string]$n.session_title + $pipe + [string]$n.machine_label }
    $payload = @{device_key=$key;title=$title;body=$n.reply_preview;sound=$n.sound;level='active';group=('codex-task-status:'+$n.machine_label)} | ConvertTo-Json -Compress
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $r = Invoke-WebRequest -Uri 'https://api.day.app/push' -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 8 -UseBasicParsing
    $json = $r.Content | ConvertFrom-Json
    if ($r.StatusCode -eq 200 -and $json.code -eq 200) { '{"status":"accepted","http_status":200}' }
    else { '{"status":"send_failed"}' }
} catch {
    if ($phase -eq 'credential') { '{"status":"credential_unavailable"}' } else { '{"status":"send_failed"}' }
} finally {
    if ($null -ne $bytes) { [Array]::Clear($bytes,0,$bytes.Length) }
    $key=$null; $payload=$null
}
exit 0
