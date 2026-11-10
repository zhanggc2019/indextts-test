import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomUUID, randomInt, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setMaxListeners } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { markdownReport, csvReport, summarize, distribution, analyzeDownloadFailures } from './public/stats.js';
import { requestBuffer } from './net-client.mjs';
export { requestBuffer } from './net-client.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/** 校验基础地址，禁止把凭据或查询参数混入后续接口路径。 */
function validateBaseUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value.trim())) throw new Error('TTS 地址须为完整的 HTTP 或 HTTPS 基础地址');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('TTS 地址格式无效'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('TTS 地址不能包含用户名、密码、查询参数或片段');
  return url.href.replace(/\/+$/, '');
}

/** 从环境或用户现有文档读取凭据；不把密钥写入源代码、响应或报告。 */
export function loadConfig() {
  let key = process.env.TTS_API_KEY || '';
  if (!key && process.env.TTS_DOC_PATH) {
    try { key = fs.readFileSync(process.env.TTS_DOC_PATH, 'utf8').match(/\| API Key \|\s*`([^`]+)`/)?.[1] || ''; } catch { /* 允许无凭据启动页面。 */ }
  }
  return { apiKey: key, baseUrl: process.env.TTS_BASE_URL || 'https://tts.lanyun.net',
    dataDir: process.env.TTS_DATA_DIR || path.join(ROOT, 'data'), port: Number(process.env.PORT || 8765),
    corpusPath: process.env.TTS_CORPUS_PATH || path.join(ROOT, 'text-corpus.json') };
}

/** 读取项目内的纯文本语料；保留来源记录号并按文本去重。 */
export function loadCorpus(filename = path.join(ROOT, 'text-corpus.json')) {
  if (!fs.existsSync(filename)) return null;
  const data = JSON.parse(fs.readFileSync(filename, 'utf8')); const seen = new Set();
  const entries = [];
  for (const item of data.entries || []) {
    const text = String(item.text || '').trim();
    if (!text || Array.from(text).length > 5000 || seen.has(text)) continue;
    seen.add(text); entries.push({ text, sourceId: String(item.sourceId || ''), sourceRecord: item.sourceRecord });
  }
  return { sourceFile: String(data.sourceFile || path.basename(filename)), column: String(data.column || '合成文字'),
    sourceSha256: data.sourceSha256 || null, corpusSha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex'), entries };
}

/** 按可复现种子进行 Fisher–Yates 抽样，一轮内不放回抽取。 */
export function sampleCorpus(entries, count, seed) {
  if (count > entries.length) throw new Error(`语料不足：需要 ${count} 条不同文本，只有 ${entries.length} 条`);
  let state = seed >>> 0; const shuffled = [...entries];
  for (let i = 0; i < count; i++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5; state >>>= 0;
    const j = i + Math.floor((state / 4294967296) * (shuffled.length - i));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count);
}

/** 校验 WAV 结构并尽可能读取音频时长，不把 HTML 错误页当作成功下载。 */
export function inspectAudio(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('下载内容不是有效的 WAV 音频');
  let rate = 0; let data = null;
  for (let p = 12; p + 8 <= buffer.length;) {
    const kind = buffer.toString('ascii', p, p + 4); const size = buffer.readUInt32LE(p + 4);
    if (p + 8 + size > buffer.length) throw new Error('WAV 音频数据不完整');
    if (kind === 'fmt ' && size >= 16) rate = buffer.readUInt32LE(p + 16);
    if (kind === 'data') data = size;
    p += 8 + size + (size % 2);
  }
  if (!rate || !data) throw new Error('WAV 缺少有效音频数据');
  return data / rate * 1000;
}

/** 校验页面提交的测试配置并限制单次任务规模。 */
export function validateConfig(input, corpus = null) {
  const mode = input.mode || (input.requests == null ? 'duration' : 'count');
  if (!['duration','count'].includes(mode)) throw new Error('测试模式无效');
  const concurrencies = [...new Set(String(input.concurrencies || (mode === 'duration' ? '4,8,16,24,32' : '1,2,4')).split(/[,，\s]+/).filter(Boolean).map(Number))];
  if (!concurrencies.length || concurrencies.length > 8 || concurrencies.some(n => !Number.isSafeInteger(n) || n < 1)) throw new Error('并发数须为有效的正整数，最多 8 档');
  const requests = mode === 'count' ? Number(input.requests ?? 4) : null;
  if (mode === 'count' && (!Number.isInteger(requests) || requests < Math.max(...concurrencies) || requests > 500 || requests * concurrencies.length > 2000)) throw new Error('每档请求数须不少于最大并发数，且不超过 500；总请求不超过 2000');
  const runMode = input.runMode || (concurrencies.length === 1 ? 'single' : 'ladder');
  if (!['single','ladder'].includes(runMode) || (runMode === 'single' && concurrencies.length !== 1)) throw new Error('单档模式只能设置一个并发数');
  const stageSeconds = mode === 'duration' ? Number(input.stageSeconds ?? (runMode === 'single' && input.hours != null ? Number(input.hours) * 3600 : Number(input.stageMinutes ?? 10) * 60)) : null;
  const maxSeconds = runMode === 'single' ? 168 * 3600 : 3600;
  if (mode === 'duration' && (!Number.isFinite(stageSeconds) || stageSeconds < 1 || stageSeconds > maxSeconds)) throw new Error(`持续时间须在 1～${maxSeconds} 秒之间`);
  const textSource = input.textSource || 'manual';
  if (!['manual', 'csv'].includes(textSource)) throw new Error('文本来源无效');
  const texts = textSource === 'manual' ? String(input.text || '').split(/\r?\n/).map(t => t.trim()).filter(Boolean) : [];
  if (textSource === 'manual' && (!texts.length || texts.some(t => Array.from(t).length > 5000) || texts.length > 100)) throw new Error('请输入测试文本：每行 1～5000 字符，最多 100 行');
  const voiceMode = input.voiceMode || 'random';
  if (!['random','fixed'].includes(voiceMode)) throw new Error('音色模式无效');
  const voiceId = voiceMode === 'fixed' ? String(input.voiceId || '').trim() : null;
  if (voiceMode === 'fixed' && !/^[A-Za-z0-9_-]{1,64}$/.test(voiceId)) throw new Error('请输入有效的系统 voice_id');
  const lang = String(input.lang || 'ZH').toUpperCase();
  if (!['ZH','EN','JA','ES','AR'].includes(lang)) throw new Error('语言参数无效');
  const config = { mode, runMode, concurrencies, requests, stageSeconds, texts, voiceMode, voiceId, lang, textSource };
  if (input.scheduledAt != null && input.scheduledAt !== '') {
    if (typeof input.scheduledAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(input.scheduledAt)) throw new Error('预约时间须为带时区的 ISO 日期时间');
    config.scheduledAt = Date.parse(input.scheduledAt);
    if (!Number.isFinite(config.scheduledAt) || config.scheduledAt <= Date.now()) throw new Error('预约时间须晚于当前时间');
  }
  if (voiceMode === 'random') {
    config.voiceSamplingSeed = input.voiceSamplingSeed == null ? randomInt(1,4294967296) : Number(input.voiceSamplingSeed);
    if (!Number.isInteger(config.voiceSamplingSeed) || config.voiceSamplingSeed < 1 || config.voiceSamplingSeed > 4294967295) throw new Error('音色随机种子须为 1～4294967295 的整数');
  }
  for (const [key, fallback, min, max] of [['speechRate',1,.5,2],['loudnessRate',1,0,2],['synthTimeout',20,1,20],['downloadTimeout',10,1,10],['warmup',0,0,5]]) {
    const v = Number(input[key] ?? fallback);
    if (!Number.isFinite(v) || v < min || v > max || (key === 'warmup' && !Number.isInteger(v))) throw new Error(`${key} 超出允许范围 ${min}～${max}`);
    config[key] = v;
  }
  if (textSource === 'csv') {
    if (!corpus?.entries?.length) throw new Error('未加载 CSV 文本语料，请检查 text-corpus.json');
    const seed = input.samplingSeed == null || input.samplingSeed === '' ? randomInt(1, 4294967296) : Number(input.samplingSeed);
    if (!Number.isInteger(seed) || seed < 1 || seed > 4294967295) throw new Error('抽样种子须为 1～4294967295 的整数');
    config.samplingSeed = seed;
    if (mode === 'count') {
      const samples = sampleCorpus(corpus.entries, requests + config.warmup, seed);
      config.textSamples = samples.slice(0, requests);
      config.texts = config.textSamples.map(s => s.text);
      config.warmupTexts = samples.slice(requests).map(s => s.text);
    } else {
      config.warmupTexts = sampleCorpus(corpus.entries, config.warmup, (seed ^ 0x9e3779b9) >>> 0 || 1).map(s => s.text);
    }
    config.textCorpus = { sourceFile: corpus.sourceFile, column: corpus.column, count: corpus.entries.length,
      sourceSha256: corpus.sourceSha256, corpusSha256: corpus.corpusSha256 };
  }
  return config;
}

/** 创建按档位内序号取词的采样器；语料用尽后以新种子洗牌，长测不受条数限制。 */
export function createTextSampler(config, corpus) {
  const cycles = new Map();
  return index => {
    if (config.textSource !== 'csv') return { text: config.texts[index % config.texts.length] };
    if (config.mode !== 'duration') return config.textSamples[index % config.textSamples.length];
    const cycle = Math.floor(index / corpus.entries.length);
    if (!cycles.has(cycle)) cycles.set(cycle, sampleCorpus(corpus.entries, corpus.entries.length,
      (config.samplingSeed + Math.imul(cycle, 0x9e3779b9)) >>> 0 || 1));
    return cycles.get(cycle)[index % corpus.entries.length];
  };
}

/** 随机打乱音色池，逐条不放回使用；各档位复用同一序列，预热使用独立序列。 */
export function createVoiceSampler(config) {
  const cycles=new Map();
  return (index,warmup=false)=>{
    if (config.voiceMode !== 'random') return {voiceId:config.voiceId,voiceName:config.voiceName||config.voiceId};
    const pool=config.voicePool;
    if (!pool?.length) throw new Error('没有可用音色，无法开始随机音色测试');
    const cycle=Math.floor(index/pool.length),key=`${warmup}:${cycle}`;
    if (!cycles.has(key)) cycles.set(key,sampleCorpus(pool,pool.length,
      (config.voiceSamplingSeed+Math.imul(cycle,0x9e3779b9)+(warmup?0x85ebca6b:0))>>>0||1));
    return cycles.get(key)[index%pool.length];
  };
}

/** 在失败后有限等待，停止任务时立即唤醒，不跨越当前档位发压截止时间。 */
function cooldown(ms, signal) {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(finish, ms);
    /** 无论到时或取消均清理定时器及监听器。 */
    function finish() { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); }
    signal.addEventListener('abort', finish, { once: true });
  });
}

/** 创建本机测试服务；一个活动任务，任务结果和录音保存在本地。 */
export function createApp(options) {
  const opts = { ...options }; const runs = new Map(); const controls = new Map(); const schedules = new Map(); let startingRun=false;
  const corpus = loadCorpus(opts.corpusPath);
  fs.mkdirSync(opts.dataDir, { recursive: true });
  const settingsPath = path.join(opts.dataDir, 'settings.json');
  if (fs.existsSync(settingsPath)) opts.baseUrl = validateBaseUrl(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).baseUrl);
  for (const file of fs.readdirSync(opts.dataDir).filter(n => n.endsWith('.json') && n !== 'settings.json').sort().slice(-50)) {
    try {
      const run = JSON.parse(fs.readFileSync(path.join(opts.dataDir, file), 'utf8'));
      if (['running','warming','scheduled','preparing'].includes(run.status)) {
        if (run.status === 'scheduled') run.error = '预约因本地服务中断而取消，请重新预约；不会补跑';
        run.status = 'interrupted'; run.endedAt = Date.now();
        for (const r of run.results) if (!['success','failed','cancelled'].includes(r.status)) { r.status = 'cancelled'; r.error = '本地服务中断'; }
        for (const s of run.stages) if (s.startedAt && !s.endedAt) { s.endedAt = run.endedAt; s.state = 'interrupted'; s.active = 0; }
      }
      runs.set(run.id, run);
    } catch { /* 跳过损坏的历史文件。 */ }
  }

  /** 去除上游错误中可能回显的密钥，限制错误文本长度。 */
  function cleanError(error) { return String(error?.message || error).replaceAll(opts.apiKey || '\u0000', '[已隐藏]').slice(0, 700); }

  /** 用服务端凭据查询当前可用音色；限时查询且只保留安全的 ID 和名称。 */
  async function loadVoicePool(signal) {
    const res=await requestBuffer(`${opts.baseUrl.replace(/\/$/,'')}/api/v1/voices`,{
      headers:{'X-API-Key':opts.apiKey},signal,timeoutMs:8000,maxBytes:4*1024*1024,expectedStatus:200});
    let result;try {result=JSON.parse(res.buffer.toString('utf8'));} catch {throw new Error('音色列表不是有效 JSON');}
    if (!Array.isArray(result.voices)) throw new Error('音色列表缺少 voices 数组');
    const pool=new Map();
    for (const voice of result.voices) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(voice.voice_id||'') || voice.api_visible===false) continue;
      pool.set(voice.voice_id,{voiceId:voice.voice_id,voiceName:String(voice.name||voice.voice_id).slice(0,200)});
    }
    if (!pool.size) throw new Error('当前身份没有可用音色，请检查应用 Key 和音色权限');
    return [...pool.values()];
  }

  /** 将本工具生成的历史文件移入可恢复归档，校验路径并在失败时回滚。 */
  function clearHistory() {
    if (controls.size || startingRun) throw new Error('测试正在运行、准备中或等待预约，请先停止后再清空历史');
    const root=fs.realpathSync(opts.dataDir),idPattern=/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/;
    const entries=fs.readdirSync(root,{withFileTypes:true}),ids=new Set([...runs.keys()].filter(id=>idPattern.test(id)));
    for (const entry of entries) {
      const id=entry.name.replace(/\.json$/,'');
      if (!entry.isFile() || !entry.name.endsWith('.json') || !idPattern.test(id)) continue;
      ids.add(id);
      let saved;try {saved=JSON.parse(fs.readFileSync(path.join(root,entry.name),'utf8'));} catch {continue;}
      if (['running','warming','scheduled','preparing'].includes(saved.status)) throw new Error(`磁盘中仍有运行中或预约中的测试 ${id}，请在对应服务停止后再清空`);
    }
    const files=entries.filter(entry=>[...ids].some(id=>entry.name===id||['.json','.json.tmp','.md','.csv','.download-failures.csv'].some(ext=>entry.name===id+ext)));
    if (!files.length) {runs.clear();return {cleared:ids.size,archivedFiles:0,archivePath:null};}
    const archivePath=path.join(root,'.history-trash',new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8));
    if (!archivePath.startsWith(root+path.sep)) throw new Error('历史归档路径不在数据目录内');
    fs.mkdirSync(archivePath,{recursive:true});
    if (!fs.realpathSync(archivePath).startsWith(root+path.sep)) throw new Error('实际归档路径不在数据目录内');
    const moved=[];
    try {
      for (const entry of files) {
        const from=path.resolve(root,entry.name),to=path.resolve(archivePath,entry.name);
        if (path.dirname(from)!==root || path.dirname(to)!==archivePath) throw new Error('历史文件路径校验失败');
        fs.renameSync(from,to);moved.push({from,to});
      }
    } catch(error) {for (const file of moved.reverse())fs.renameSync(file.to,file.from);throw error;}
    runs.clear();return {cleared:ids.size,archivedFiles:files.length,archivePath};
  }

  /** 原子保存快照，防止重启后把半写入数据误认为完整结果。 */
  function persist(run) {
    const target = path.join(opts.dataDir, `${run.id}.json`);
    fs.writeFileSync(target + '.tmp', JSON.stringify(run, null, 2)); fs.renameSync(target + '.tmp', target);
  }

  /** 为每条请求固定实际文本、来源和档位内序号，持续模式不预设总请求数。 */
  function newRow(run, stage, index, sample) {
    const row = { id: run.results.length + 1, stage: stage.index, stageRequest: index + 1,
      status: 'pending', synthOK: false, text: sample.text, textChars: Array.from(sample.text).length,
      sourceId: sample.sourceId, sourceRecord: sample.sourceRecord };
    run.results.push(row); return row;
  }

  /** 计算整场指标，并为持续轮询仅发送最近 200 条明细。 */
  function snapshot(run, compact = false) {
    const summary = summarize(run);
    const success = run.results.filter(r => r.status === 'success');
    const synth = run.results.filter(r => r.synthOK);
    const overall = { total: run.results.length, attempted: run.results.filter(r => r.startedAt).length,
      success: success.length, failed: run.results.filter(r => r.status === 'failed').length,
      timedOut: run.results.filter(r => r.timedOut).length, cancelled: run.results.filter(r => r.status === 'cancelled').length,
      synth: distribution(synth.map(r => r.synthMs)), download: distribution(success.map(r => r.downloadMs)) };
    return { ...run, results: compact ? run.results.slice(-200) : run.results, summary, overall,
      downloadFailureAnalysis:analyzeDownloadFailures(run,compact?100:Infinity),
      detailOffset: compact ? Math.max(0, run.results.length - 200) : 0 };
  }

  /** 执行一条合成与下载链，记录阶段成功、失败和单调时钟耗时。 */
  async function execute(run, row, signal, warmup = false, voiceSampler = createVoiceSampler(run.config)) {
    row.startedAt = Date.now(); row.queueMs = warmup || run.config.mode === 'duration' ? 0 : row.startedAt - run.stages[row.stage].startedAt;
    row.status = 'synthesizing'; row.phase = 'synthesis';
    const begin = performance.now(); let phaseStart = begin;
    try {
      row.text = warmup ? (run.config.warmupTexts?.[row.id - 1] ?? run.config.texts[(row.id - 1) % run.config.texts.length]) : row.text;
      row.textChars = Array.from(row.text).length;
      const voice=voiceSampler(warmup?row.id-1:row.stageRequest-1,warmup);
      row.voiceId=voice.voiceId;row.voiceName=voice.voiceName;
      const body = JSON.stringify({ voice_id: row.voiceId, text: row.text,
        lang: run.config.lang, speech_rate: run.config.speechRate, loudness_rate: run.config.loudnessRate });
      const res = await requestBuffer(`${opts.baseUrl.replace(/\/$/, '')}/api/v1/tts/synthesize`, {
        method: 'POST', headers: { 'X-API-Key': opts.apiKey, 'X-Audio-Delivery': 'minio', 'X-Audio-Purpose': 'live_socket', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        body, timeoutMs: run.config.synthTimeout * 1000, signal, maxBytes: 1024 * 1024 });
      row.synthAttemptMs = res.ms; row.synthHttpStatus = res.status;
      row.requestId = res.headers['x-request-id'] || null;
      row.ttsWorker = res.headers['x-tts-worker'] || null;
      row.ttsBatchId = res.headers['x-tts-batch-id'] || null;
      row.ttsBatchSize = res.headers['x-tts-batch-size'] || null;
      row.serverTiming = res.headers['server-timing'] || null;
      row.retryAfter = res.headers['retry-after'] || null;
      if (res.status !== 201) { row.httpStatus = res.status; throw new Error(`合成 HTTP ${res.status}：${res.buffer.toString('utf8').slice(0, 500)}`); }
      let result;
      try { result = JSON.parse(res.buffer.toString('utf8')); } catch { throw new Error('合成响应不是有效 JSON'); }
      row.audioId = result.audio_id ?? null;
      row.audioStorage = result.audio_storage ?? null;
      row.audioCreatedAt = result.created_at ?? null;
      row.audioExpiresAt = result.expires_at ?? null;
      row.serverAudioDurationMs = result.duration_ms ?? null;
      row.serverAudioSizeBytes = result.size_bytes ?? null;
      row.subtitles = Array.isArray(result.subtitles) ? result.subtitles : null;
      row.subtitleCount = row.subtitles?.length ?? null;
      row.subtitleMode = result.subtitle_mode ?? null;
      row.subtitleUrl = result.subtitle_url ?? null;
      row.subtitleStorage = result.subtitle_storage ?? null;
      row.audioUrlOriginal = typeof result.audio_url === 'string' ? result.audio_url : null;
      if (typeof result.audio_url !== 'string' || !result.audio_url) throw new Error('合成响应缺少 audio_url');
      row.audioUrl = result.audio_url;
      row.synthOK = true; row.synthMs = res.ms;
      row.status = 'downloading'; row.phase = 'download'; phaseStart = performance.now();
      let audio;
      try {
        row.audioUrl = new URL(row.audioUrl,opts.baseUrl).href;
        row.downloadRequestUrl = row.audioUrl;
        audio = await requestBuffer(row.audioUrl, { timeoutMs: run.config.downloadTimeout * 1000, signal, expectedStatus:200 });
      } catch(error) {
        row.downloadDiagnostics = error.diagnostics || {originalUrl:row.audioUrl,currentUrl:row.audioUrl,phase:'url_validation',receivedBytes:0};
        row.downloadErrorCode = error.code || 'INVALID_URL';
        throw error;
      }
      row.downloadDiagnostics = audio.diagnostics;
      row.downloadAttemptMs = audio.ms; row.downloadHttpStatus = audio.status;
      if (audio.status !== 200) { row.httpStatus = audio.status; throw new Error(`下载 HTTP ${audio.status}`); }
      try {row.audioDurationMs = inspectAudio(audio.buffer);}
      catch(error) {row.downloadFailureStage='validation';row.downloadErrorCode='INVALID_AUDIO';throw error;}
      row.downloadMs = audio.ms; row.downloadTtfbMs = audio.ttfb; row.bytes = audio.buffer.length;
      row.e2eMs = performance.now() - begin;
      if (!warmup && (run.config.mode !== 'duration' || row.stageRequest <= 3)) {
        row.phase = 'storage';
        const folder = path.join(opts.dataDir, run.id); fs.mkdirSync(folder, { recursive: true });
        await fs.promises.writeFile(path.join(folder, `${row.id}.wav`), audio.buffer);
        row.localAudio = true;
      }
      row.status = 'success'; row.phase = 'complete';
      row.downloadFinalUrl = row.downloadDiagnostics?.currentUrl || row.audioUrl;
      delete row.downloadDiagnostics;
    } catch (error) {
      const elapsed = performance.now() - phaseStart;
      if (row.phase === 'synthesis' && row.synthAttemptMs == null) row.synthAttemptMs = elapsed;
      if (row.phase === 'download' && row.downloadAttemptMs == null) row.downloadAttemptMs = elapsed;
      row.e2eMs = performance.now() - begin;
      row.status = signal.aborted ? 'cancelled' : 'failed'; row.error = cleanError(error);
      if(row.phase === 'download') {
        const diag = row.downloadDiagnostics;
        row.downloadFailureStage = row.downloadFailureStage || diag?.phase || 'unknown';
        row.downloadErrorCode = row.downloadErrorCode || error.code || 'DOWNLOAD_ERROR';
        row.downloadFailureKind = signal.aborted ? 'cancelled' : error.name === 'TimeoutError' ? 'timeout' :
          row.downloadErrorCode.startsWith('HTTP_') ? 'http' : ['INVALID_AUDIO','INVALID_URL','RESPONSE_TOO_LARGE'].includes(row.downloadErrorCode) ? 'validation' : 'network';
        row.downloadFinalUrl = diag?.currentUrl || row.audioUrl;
        row.downloadReceivedBytes = diag?.receivedBytes ?? 0; row.downloadExpectedBytes = diag?.expectedBytes ?? null;
        row.downloadContentType = diag?.contentType ?? null; row.downloadTtfbMs = diag?.firstByteMs ?? null;
        if(diag?.httpStatus) {row.downloadHttpStatus=diag.httpStatus;row.httpStatus=diag.httpStatus;}
      }
      if (error.name === 'TimeoutError') {
        row.timedOut = true;
        row.error = `${row.phase === 'synthesis' ? '合成' : '下载'}超时（${row.phase === 'synthesis' ? run.config.synthTimeout : run.config.downloadTimeout} 秒），已中断等待`;
      }
    }
    row.endedAt = Date.now();
  }

  /** 统一收尾和保存报告，预约取消或启动失败时也留下可查看的记录。 */
  function finishRun(run) {
    for (const row of run.results) if (row.status === 'pending') { row.status = 'cancelled'; row.error = '未启动'; }
    for (const stage of run.stages) if (!stage.startedAt) stage.state = 'skipped';
    run.endedAt = Date.now();
    for (const stage of run.stages) if (stage.startedAt && !stage.endedAt) {
      stage.endedAt = run.endedAt; stage.state = run.status; stage.active = 0;
    }
    try {
      persist(run);
      fs.writeFileSync(path.join(opts.dataDir, `${run.id}.md`), markdownReport(run));
      fs.writeFileSync(path.join(opts.dataDir, `${run.id}.csv`), csvReport(run));
      fs.writeFileSync(path.join(opts.dataDir, `${run.id}.download-failures.csv`),csvReport({...run,results:analyzeDownloadFailures(run).failures}));
      run.reportsReady = true; persist(run);
    } catch (e) { run.persistenceError = cleanError(e); console.error('保存报告失败：', cleanError(e)); }
    controls.delete(run.id);
  }

  /** 到预约时间才查询音色并预热；超过一分钟视为错过，避免休眠后在高峰补跑。 */
  async function startScheduled(run, controller) {
    if (controller.signal.aborted) return;
    const remaining = run.config.scheduledAt - Date.now();
    if (remaining > 0) {
      schedules.set(run.id, setTimeout(() => startScheduled(run, controller), Math.min(remaining, 1000)));
      return;
    }
    schedules.delete(run.id);
    try {
      if (remaining < -60000) throw new Error('已错过预约时间超过 1 分钟，未启动测试，请重新预约');
      run.status = 'preparing'; persist(run);
      if (run.config.voiceMode === 'random') run.config.voicePool = await loadVoicePool(controller.signal);
      controller.signal.throwIfAborted();
      run.startedAt = Date.now(); run.status = run.config.warmup ? 'warming' : 'running'; persist(run);
    } catch (error) {
      run.status = controller.signal.aborted ? 'cancelled' : 'failed'; run.error = cleanError(error);
      finishRun(run); return;
    }
    await drive(run, controller);
  }

  /** 按阶梯顺序运行固定并发工作池；不自动重试任何请求。 */
  async function drive(run, controller) {
    const signal = controller.signal;
    const sampler = createTextSampler(run.config, corpus);
    const voiceSampler = createVoiceSampler(run.config);
    const checkpoint = setInterval(() => { try { persist(run); } catch (e) { run.persistenceError = cleanError(e); } }, 5000);
    checkpoint.unref();
    try {
      for (let i = 0; i < run.config.warmup && !signal.aborted; i++) {
        run.warmupDone = i;
        const row = { id: i + 1 };
        await execute(run, row, signal, true, voiceSampler);
        if (signal.aborted) break;
        if (row.status !== 'success') { run.warmupError = row.error; throw new Error('预热失败，未启动正式测试'); }
        run.warmupDone = i + 1;
      }
      run.status = 'running';
      for (const stage of run.stages) {
        if (signal.aborted) break;
        stage.startedAt = Date.now(); stage.state = 'running'; let cursor = 0; let active = 0;
        const stageClock = performance.now();
        const timed = run.config.mode === 'duration';
        const deadline = timed ? stageClock + run.config.stageSeconds * 1000 : Infinity;
        if (timed) stage.deadlineAt = stage.startedAt + run.config.stageSeconds * 1000;
        const rows = run.results.filter(r => r.stage === stage.index);
        /** 每个工作槽位完成整条合成和下载后才取下一条请求。 */
        async function worker() {
          while (!signal.aborted && (timed ? performance.now() < deadline : cursor < rows.length)) {
            const index = cursor++;
            const row = timed ? newRow(run, stage, index, sampler(index)) : rows[index];
            active++; stage.active = active; stage.peakActive = Math.max(stage.peakActive, active);
            try { await execute(run, row, signal, false, voiceSampler); } finally { active--; stage.active = active; }
            if (timed && performance.now() >= deadline) stage.state = 'draining';
            if (timed && row.status === 'failed') await cooldown(Math.min(1000, deadline - performance.now()), signal);
          }
        }
        persist(run);
        await Promise.all(Array.from({ length: stage.concurrency }, () => worker()));
        stage.endedAt = Date.now(); stage.elapsedMs = performance.now() - stageClock;
        stage.state = signal.aborted ? 'cancelled' : 'completed'; persist(run);
      }
      run.status = signal.aborted ? 'cancelled' : 'completed';
    } catch (error) { run.status = signal.aborted ? 'cancelled' : 'failed'; run.error = cleanError(error); }
    finally {
      clearInterval(checkpoint);
      finishRun(run);
    }
  }

  /** 返回 JSON 或文本，统一禁止跨域及缓存。 */
  function respond(res, status, value, type = 'application/json; charset=utf-8') {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
  }

  /** 读取小型 JSON 请求体，避免无限内存占用。 */
  async function readJson(req) {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new Error('必须使用 application/json');
    let body = '';
    for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 1024 * 1024) throw new Error('请求体过大'); }
    return JSON.parse(body);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || '';
      if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return respond(res, 403, { error: '只接受本机访问' });
      if (req.headers.origin && req.headers.origin !== `http://${host}`) return respond(res, 403, { error: '禁止跨站访问' });
      const url = new URL(req.url, `http://${host}`); const p = url.pathname;
      if (req.method === 'GET' && p === '/api/config') return respond(res, 200, {
        baseUrl: opts.baseUrl, hasKey: Boolean(opts.apiKey), endpoint: '/api/v1/tts/synthesize',
        timeoutPolicy: { synthTimeout: 20, downloadTimeout: 10 },
        benchmarkMode: 'duration', defaultConcurrencies: [4,8,16,24,32], defaultStageSeconds: 600,
        features: { manualStopReport: true, singleConcurrencyHours: true, downloadDiagnostics: true, successAudioUrls: true, apiGuide20261030: true, allAudioUrls: true, minioDeliveryHeaders: true, randomVoices: true, clearHistory: true, unrestrictedConcurrency: true, scheduledStart: true, editableBaseUrl: true },
        textCorpus: corpus ? { sourceFile: corpus.sourceFile, column: corpus.column, count: corpus.entries.length,
          minChars: Math.min(...corpus.entries.map(e => Array.from(e.text).length)), maxChars: Math.max(...corpus.entries.map(e => Array.from(e.text).length)),
          examples: corpus.entries.slice(0, 2).map(e => e.text) } : null });
      if (req.method === 'POST' && p === '/api/config') {
        const input = await readJson(req);
        if (controls.size || startingRun) return respond(res, 409, { error: '测试正在运行、准备中或等待预约，请先停止后再更换 TTS 地址' });
        const baseUrl = validateBaseUrl(input?.baseUrl);
        fs.writeFileSync(settingsPath + '.tmp', JSON.stringify({ baseUrl }, null, 2));
        fs.renameSync(settingsPath + '.tmp', settingsPath);
        opts.baseUrl = baseUrl;
        return respond(res, 200, { baseUrl });
      }
      if (req.method === 'GET' && p === '/api/runs') return respond(res, 200, [...runs.values()].reverse().map(r => ({ id: r.id, createdAt: r.createdAt, status: r.status, mode: r.config.mode || 'count', concurrencies: r.config.concurrencies })));
      if (req.method === 'GET' && p === '/api/voices') {
        if (!opts.apiKey) return respond(res,400,{error:'未配置 API Key，无法读取音色'});
        try {return respond(res,200,{voices:await loadVoicePool()});}
        catch(error) {return respond(res,502,{error:'获取音色失败：'+cleanError(error)});}
      }
      if (req.method === 'POST' && p === '/api/history/clear') {
        await readJson(req);
        try {return respond(res,200,clearHistory());}
        catch(error) {return respond(res,409,{error:cleanError(error)});}
      }
      if (req.method === 'POST' && p === '/api/runs') {
        if (!opts.apiKey) return respond(res, 400, { error: '未配置 API Key：请设置 TTS_API_KEY 或 TTS_DOC_PATH 后重启服务' });
        if (controls.size || startingRun) return respond(res, 409, { error: '已有测试正在运行、准备中或等待预约，请先等待完成或停止' });
        const config = validateConfig(await readJson(req), corpus);
        if (controls.size || startingRun) return respond(res,409,{error:'已有测试正在运行、准备中或等待预约'});
        if (config.voiceMode === 'random' && !config.scheduledAt) {
          startingRun=true;
          try {config.voicePool=await loadVoicePool();}
          catch(error) {return respond(res,502,{error:'无法开始随机音色测试：'+cleanError(error)});}
          finally {startingRun=false;}
        }
        config.audioDelivery = 'minio'; config.audioPurpose = 'live_socket';
        const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
        const run = { id, createdAt: Date.now(), startedAt: config.scheduledAt ? null : Date.now(), status: config.scheduledAt ? 'scheduled' : config.warmup ? 'warming' : 'running', baseUrl: opts.baseUrl, config,
          stages: config.concurrencies.map((concurrency, index) => ({ index, concurrency, peakActive: 0, active: 0, state: 'pending' })), results: [] };
        if (config.mode === 'count') {
          const sampler = createTextSampler(config, corpus);
          for (const s of run.stages) for (let i = 0; i < config.requests; i++) newRow(run, s, i, sampler(i));
        }
        runs.set(id, run); const controller = new AbortController(); setMaxListeners(0, controller.signal);
        controls.set(id, controller);
        try { persist(run); } catch (error) { controls.delete(id); runs.delete(id); throw error; }
        if (config.scheduledAt) startScheduled(run, controller);
        else setImmediate(() => drive(run, controller));
        return respond(res, 201, { id });
      }
      const match = p.match(/^\/api\/runs\/([^/]+)(?:\/(stop|download-failures\.csv|report\.(?:md|json|csv)|audio\/(\d+)))?$/);
      if (match) {
        const run = runs.get(match[1]); if (!run) return respond(res, 404, { error: '测试不存在' });
        if (req.method === 'POST' && match[2] === 'stop') {
          await readJson(req);
          const controller = controls.get(run.id);
          if (controller && !controller.signal.aborted) {
            run.stopRequestedAt = Date.now(); run.stopReason = '用户手动停止';
            controller.abort(new Error('用户手动停止测试'));
            if (run.status === 'scheduled') {
              clearTimeout(schedules.get(run.id)); schedules.delete(run.id);
              run.status = 'cancelled'; run.stopReason = '用户取消预约'; finishRun(run);
            }
          }
          return respond(res, 200, { ok: true, reportsReady: Boolean(run.reportsReady) });
        }
        if (req.method === 'GET' && !match[2]) return respond(res, 200, snapshot(run, url.searchParams.get('compact') === '1'));
        if(req.method==='GET'&&match[2]==='download-failures.csv') {
          res.setHeader('Content-Disposition',`attachment; filename="indextts-${run.id}-download-failures.csv"`);
          return respond(res,200,csvReport({...run,results:analyzeDownloadFailures(run).failures}),'text/csv; charset=utf-8');
        }
        if (req.method === 'GET' && match[2]?.startsWith('report.')) {
          const format = match[2].split('.')[1];
          res.setHeader('Content-Disposition', `attachment; filename="indextts-${run.id}.${format}"`);
          if (format === 'md') return respond(res, 200, markdownReport(run), 'text/markdown; charset=utf-8');
          if (format === 'csv') return respond(res, 200, csvReport(run), 'text/csv; charset=utf-8');
          return respond(res, 200, snapshot(run));
        }
        if (req.method === 'GET' && match[3]) {
          const row = run.results.find(r => String(r.id) === match[3]);
          if (!row?.localAudio) return respond(res, 404, { error: '无本地录音' });
          const audio = path.join(opts.dataDir, run.id, `${row.id}.wav`);
          res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': fs.statSync(audio).size, 'Content-Disposition': `inline; filename="${row.id}.wav"` });
          fs.createReadStream(audio).pipe(res); return;
        }
      }
      if (req.method === 'GET' && ['/', '/app.js', '/stats.js', '/style.css', '/corpus.css'].includes(p)) {
        const name = p === '/' ? 'index.html' : p.slice(1);
        const types = { html: 'text/html', css: 'text/css', js: 'text/javascript' };
        return respond(res, 200, fs.readFileSync(path.join(ROOT, 'public', name)), types[name.split('.').at(-1)] + '; charset=utf-8');
      }
      respond(res, 404, { error: '未找到资源' });
    } catch (error) { respond(res, 400, { error: cleanError(error) }); }
  });
  server.requestTimeout = 30000;
  /** 清理预约计时器和在途连接，重启时将未执行预约标为中断而不补跑。 */
  function shutdown() {
    for (const timer of schedules.values()) clearTimeout(timer);
    schedules.clear();
    for (const c of controls.values()) c.abort(new Error('服务关闭'));
    server.close();
  }
  return { server, runs, shutdown };
}

/** Windows 下在服务就绪后打开默认浏览器，避免启动页面时连接被拒绝。 */
function openBrowser(url) {
  if (process.platform !== 'win32') return;
  const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true, detached: true, stdio: 'ignore' });
  child.on('error', () => console.log('请在浏览器中手动打开上方本地地址。'));
  child.unref();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const config = loadConfig(); const app = createApp(config);
  app.server.listen(config.port, '127.0.0.1', () => {
    console.log(`IndexTTS 并发测试台：http://127.0.0.1:${config.port}`);
    console.log(`API Key：${config.apiKey ? '已从本机配置加载' : '未配置'}；只调用语音合成接口。`);
    if (process.argv.includes('--open')) openBrowser(`http://127.0.0.1:${config.port}`);
  });
  app.server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `端口 ${config.port} 已被占用，可设置 PORT 环境变量` : e.message); process.exitCode = 1; });
  process.on('SIGINT', () => app.shutdown());
  process.on('SIGTERM', () => app.shutdown());
}
