# 启动本机测试服务，并在浏览器中打开测试页面。
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

# 父进程可能仍持有设置前的环境；缺少凭据变量时补读 Windows 用户、系统持久配置。
foreach ($benchVariable in @('TTS_API_KEY', 'TTS_DOC_PATH')) {
    if (-not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($benchVariable, 'Process'))) { continue }
    foreach ($benchRegistryPath in @('HKCU:\Environment', 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment')) {
        try {
            $benchValue = Get-ItemPropertyValue -LiteralPath $benchRegistryPath -Name $benchVariable -ErrorAction Stop
        } catch { continue } # 某个范围未配置该变量时，继续尝试下一范围。
        if (-not [string]::IsNullOrWhiteSpace($benchValue)) {
            [Environment]::SetEnvironmentVariable($benchVariable, $benchValue, 'Process')
            break
        }
    }
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host '请先安装 Node.js 20 或更高版本。' -ForegroundColor Yellow
    Read-Host '按回车关闭'
    exit 1
}
if (-not $env:PORT) {
    foreach ($benchPort in 8765..8775) {
        $benchUrl = "http://127.0.0.1:$benchPort"
        try {
            $benchConfig = Invoke-RestMethod -Uri "$benchUrl/api/config" -TimeoutSec 1
            if ($benchConfig.endpoint -eq '/api/v1/tts/synthesize' -and $benchConfig.textCorpus.sourceFile -eq 'task-media-20261030.csv' -and $benchConfig.timeoutPolicy.synthTimeout -eq 20 -and $benchConfig.timeoutPolicy.downloadTimeout -eq 10 -and $benchConfig.benchmarkMode -eq 'duration' -and $benchConfig.features.singleConcurrencyHours -and $benchConfig.features.downloadDiagnostics -and $benchConfig.features.allAudioUrls -and $benchConfig.features.apiGuide20261030 -and $benchConfig.features.minioDeliveryHeaders -and $benchConfig.features.randomVoices -and $benchConfig.features.clearHistory -and $benchConfig.features.unrestrictedConcurrency -and $benchConfig.features.scheduledStart -and $benchConfig.features.editableBaseUrl -and $benchConfig.features.optionalAudioDownload) {
                if (-not $benchConfig.hasKey) {
                    Write-Host "跳过未加载凭据的旧测试台：$benchUrl，将启动新的服务。"
                    continue
                }
                Start-Process $benchUrl
                Write-Host "已打开运行中的测试台：$benchUrl"
                exit 0
            }
        } catch { }
        $benchListeners = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
        if (-not ($benchListeners | Where-Object Port -eq $benchPort)) {
            $env:PORT = [string]$benchPort
            break
        }
    }
    if (-not $env:PORT) { throw '8765～8775 端口均已占用，请通过 PORT 指定空闲端口。' }
}
node (Join-Path $PSScriptRoot 'server.mjs') --open
Read-Host '服务已结束，按回车关闭'
