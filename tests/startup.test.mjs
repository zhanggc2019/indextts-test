import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const windowsOnly = { skip: process.platform !== 'win32' };
const scriptPath = fileURLToPath(new URL('../start.ps1', import.meta.url));

/** 在独立 PowerShell 中执行真实启动脚本，以假注册表和假 Node 验证启动行为。 */
function launch(scenario) {
  const harness = `
$scenario = ConvertFrom-Json $env:INDEXTTS_START_TEST_FIXTURE
$script:lookupCount = 0
# 返回测试持久变量，不读写真实注册表或凭据。
function Get-ItemPropertyValue {
    param($LiteralPath, $Name, $ErrorAction)
    if ($LiteralPath -eq 'HKCU:\\Environment') { $value = $scenario.user.$Name }
    else { $value = $scenario.machine.$Name }
    if ($null -eq $value) { throw '该范围不存在此变量' }
    return $value
}
# 模拟已有服务；后续端口没有可复用服务。
function Invoke-RestMethod {
    param($Uri, $TimeoutSec)
    $script:lookupCount++
    if ($script:lookupCount -gt 1) { throw '没有运行中的模拟服务' }
    $features = @{}
    foreach ($name in @('singleConcurrencyHours','downloadDiagnostics','allAudioUrls','apiGuide20261030','minioDeliveryHeaders','randomVoices','clearHistory','unrestrictedConcurrency','scheduledStart','editableBaseUrl')) { $features[$name] = $true }
    return @{endpoint='/api/v1/tts/synthesize';textCorpus=@{sourceFile='task-media-20261030.csv'};timeoutPolicy=@{synthTimeout=20;downloadTimeout=10};benchmarkMode='duration';features=$features;hasKey=$scenario.existingHasKey}
}
# 记录复用，不打开真实浏览器。
function Start-Process {
    param($FilePath)
    Write-Output ('__START_TEST__' + (@{reused=$true;url=$FilePath} | ConvertTo-Json -Compress))
}
# 记录假凭据和启动端口，不启动 Node 或调用 TTS。
function node {
    param($ServerPath, $OpenOption)
    Write-Output ('__START_TEST__' + (@{reused=$false;key=$env:TTS_API_KEY;doc=$env:TTS_DOC_PATH;port=$env:PORT} | ConvertTo-Json -Compress))
}
# 避免交互等待。
function Read-Host {}
& $env:INDEXTTS_START_SCRIPT
`;
  const result = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',harness], {
    encoding:'utf8', timeout:20000,
    env: { ...process.env, TTS_API_KEY:scenario.processKey || '', TTS_DOC_PATH:scenario.processDoc || '',
      PORT:scenario.scan ? '' : '18765', INDEXTTS_START_SCRIPT:scriptPath,
      INDEXTTS_START_TEST_FIXTURE:JSON.stringify({user:{},machine:{},...scenario}) }
  });
  assert.equal(result.error,undefined);
  assert.equal(result.status,0,result.stderr);
  const record = result.stdout.match(/^__START_TEST__(.+)$/m);
  assert.ok(record,result.stdout);
  return JSON.parse(record[1]);
}

test('启动脚本从用户持久环境补读 Key 和文档路径，不依赖父进程刷新', windowsOnly, () => {
  const result = launch({user:{TTS_API_KEY:'fake-user-key',TTS_DOC_PATH:'D:\\mock\\key.md'},machine:{TTS_API_KEY:'fake-machine-key'}});
  assert.equal(result.key,'fake-user-key'); assert.equal(result.doc,'D:\\mock\\key.md');
});

test('启动脚本在用户变量缺失或空白时读取系统变量', windowsOnly, () => {
  const result = launch({user:{TTS_API_KEY:'   '},machine:{TTS_API_KEY:'fake-machine-key'}});
  assert.equal(result.key,'fake-machine-key');
});

test('启动脚本保留当前进程显式设置的凭据', windowsOnly, () => {
  const result = launch({processKey:'fake-process-key',processDoc:'D:\\process.md',user:{TTS_API_KEY:'fake-user-key',TTS_DOC_PATH:'D:\\user.md'}});
  assert.equal(result.key,'fake-process-key'); assert.equal(result.doc,'D:\\process.md');
});

test('持久环境没有配置凭据时仍允许启动，不因缺少注册表属性退出', windowsOnly, () => {
  const result = launch({});
  assert.equal(result.reused,false); assert.equal(result.key,null); assert.equal(result.doc,null);
});

test('无凭据旧服务不能被复用，已配置服务仍可复用', windowsOnly, () => {
  const skipped = launch({scan:true,existingHasKey:false,user:{TTS_API_KEY:'fake-user-key'}});
  assert.equal(skipped.reused,false); assert.equal(skipped.key,'fake-user-key'); assert.notEqual(skipped.port,'8765');
  const reused = launch({scan:true,existingHasKey:true,user:{TTS_API_KEY:'fake-user-key'}});
  assert.equal(reused.reused,true); assert.equal(reused.url,'http://127.0.0.1:8765');
});
