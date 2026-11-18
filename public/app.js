import { distribution, seconds, analyzeDownloadFailures, audioUrlMissingReason, DOWNLOAD_PHASES } from './stats.js';
/** 按 ID 获取页面控件，供渲染与事件处理复用。 */
const $ = id => document.getElementById(id);
let current = null, timer = null, configured = false, busy = false, corpusInfo = null, pollFailures = 0, stopping = false, clearingHistory = false;
let manualText = '你好，这是一次语音合成并发测试，我们正在测量合成速度和音频下载耗时。';
let serviceReady = false, savingService = false, activeBaseUrl = '', voiceInfoVersion = 0;
const statusLabels = { pending:'等待', synthesizing:'合成中', downloading:'下载中', success:'成功', failed:'失败', cancelled:'已取消' };

/** 转义外部接口文本，避免音频 URL 和错误信息注入页面。 */
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }

/** 完整显示接口返回的 URL，保留签名查询参数，仅为 HTTP(S) 地址提供可点击链接。 */
function fullUrl(value) {
  return /^https?:\/\//i.test(value||'') ? `<a href="${esc(value)}" target="_blank" rel="noopener noreferrer">${esc(value)}</a>` : esc(value);
}

/** 在所有请求下显示完整下载地址、缺失原因以及可展开的字幕/服务端诊断。 */
function renderAudioUrlRecord(row,config={}) {
  const original=row.audioUrlOriginal||row.audioUrl;
  const links=`<div>音色：${esc(row.voiceName||row.voiceId||config.voiceId||'尚未分配')} <small>${esc(row.voiceId||config.voiceId||'')}</small></div>`+(original?`<div><b>原始音频 URL</b>${fullUrl(original)}</div>`:`<div>${esc(audioUrlMissingReason(row))}</div>`);
  const requested=row.downloadRequestUrl&&row.downloadRequestUrl!==original?`<div><b>下载请求 URL</b>${fullUrl(row.downloadRequestUrl)}</div>`:'';
  const final=row.downloadFinalUrl&&row.downloadFinalUrl!==original?`<div><b>最终下载 URL</b>${fullUrl(row.downloadFinalUrl)}</div>`:'';
  return `<tr class="url-row"><td colspan="7" class="audio-url-record">${links}${requested}${final}<details><summary>字幕、存储与服务端诊断</summary><div>音频存储：${esc(row.audioStorage||'未返回/历史未记录')} · 字幕模式：${esc(row.subtitleMode||'未返回/历史未记录')} · 字幕 ${row.subtitleCount??'—'} 条</div>${row.subtitleUrl?`<div><b>字幕 URL</b>${fullUrl(row.subtitleUrl)}</div>`:''}<div>Worker：${esc(row.ttsWorker||'—')} · 批次：${esc(row.ttsBatchId||'—')} · 批大小：${esc(row.ttsBatchSize||'—')}</div><div>请求 ID：${esc(row.requestId||'—')} · Server-Timing：${esc(row.serverTiming||'—')} · Retry-After：${esc(row.retryAfter||'—')}</div></details></td></tr>`;
}

/** 调用同源本地服务，统一显示可读的错误原因。 */
async function api(url, options) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) }); const value = await res.json();
  if (!res.ok) throw new Error(value.error || `HTTP ${res.status}`);
  return value;
}

/** 在页面顶部显示错误，同时对屏幕阅读器播报。 */
function notice(message = '') { $('notice').textContent = message; $('notice').hidden = !message; }

/** 读取当前模式的并发与时长，明确区分单档小时数和阶梯每轮分钟数。 */
function currentPlan() {
  const single = $('runMode').value === 'single';
  const stages = single ? [Number($('singleConcurrency').value)] : [...new Set($('concurrencies').value.split(/[,，\s]+/).filter(Boolean).map(Number))];
  const hours = Number($('singleHours').value) || 0, minutes = Number($('stageMinutes').value) || 0;
  return { single, stages, seconds: single ? hours * 3600 : minutes * 60,
    label: single ? `开始 ${hours} 小时单档测试` : `开始 ${stages.length * minutes} 分钟压测`,
    description: single ? `单档持续：${stages[0]} 并发 × ${hours} 小时；到时或手动停止后生成报告。` : `${stages.length} 轮 × ${minutes} 分钟 = ${stages.length * minutes} 分钟持续发压；各轮收尾另计。` };
}

/** 切换模式时禁用隐藏输入，避免表单混入另一种时长或并发配置。 */
function updateRunMode() {
  const single = $('runMode').value === 'single';
  $('ladderFields').hidden = single; $('singleFields').hidden = !single;
  for (const id of ['concurrencies','stageMinutes']) $(id).disabled = single;
  for (const id of ['singleConcurrency','singleHours']) $(id).disabled = !single;
  updatePlan();
}

/** 根据当前模式显示明确的计划和持续时间，不预估请求总数。 */
function updatePlan() {
  const plan = currentPlan();
  const downloadAudio = $('downloadAudio').value !== 'false';
  $('downloadTimeout').disabled = !downloadAudio;
  $('plan').textContent = plan.description;
  $('scheduleHint').textContent = plan.single ? '始终按固定并发补位，到时收尾并生成报告；也可随时手动停止。' : '每个请求结束后自动补位，到时自动进入下一轮；请求数由实际响应速度决定。';
  $('runNote').textContent = plan.single ? '合成上限 20 秒，下载上限 10 秒。到时停止新增请求并收尾；手动停止会取消在途连接并生成部分报告。' : '合成上限 20 秒，下载上限 10 秒。超时记为失败后继续；本轮在途请求结束后再切换下一轮。';
  if (!downloadAudio) $('runNote').textContent = '仅测试合成，拿到音频链接即成功；合成上限 20 秒，不发起下载，也不保存本地录音。';
  if (!current) {
    $('successLabel').textContent = downloadAudio ? '全流程成功率' : '获取链接成功率';
    $('downloadMetricNote').textContent = downloadAudio ? 'URL → 完整音频' : '已跳过下载测试';
  }
  if (!busy) $('start').innerHTML = `<span>▶</span> ${esc($('startMode').value === 'scheduled' ? '预约定时测试' : plan.label)}`;
  if (!current || !busy) drawStages(plan.stages.map(concurrency=>({concurrency,state:'pending'})), plan.seconds);
  $('charCount').textContent = `${Array.from($('text').value).length} 字`;
}

/** 切换一次性预约输入；浏览器按本机时区收集日期，提交时再转换为绝对时间。 */
function updateStartMode() {
  const scheduled = $('startMode').value === 'scheduled';
  $('scheduledFields').hidden = !scheduled;
  $('scheduledAt').disabled = !scheduled; $('scheduledAt').required = scheduled;
  updatePlan();
}

/** 切换 CSV 随机抽样和手动文本，标明样例与实际请求的区别。 */
function updateTextSource() {
  const csv = $('textSource').value === 'csv';
  $('text').readOnly = csv; $('text').required = !csv;
  $('textLabel').textContent = csv ? '语料样例（开始时重新抽样）' : '合成文本';
  $('textHint').textContent = csv ? '随机洗牌后逐条使用，语料用尽再洗牌循环；各档从相同序列起点取词，报告保留来源。' : '每行一条，持续轮换；各并发档位从相同序列起点取词。';
  $('corpusInfo').hidden = !csv;
  if (csv) {
    $('corpusInfo').textContent = corpusInfo?.count ? `${corpusInfo.sourceFile} · ${corpusInfo.column}列\n${corpusInfo.count} 条文本 · ${corpusInfo.minChars}～${corpusInfo.maxChars} 字` : 'CSV 语料未加载';
    $('text').value = corpusInfo?.examples?.join('\n\n') || '';
  } else $('text').value = manualText;
  updatePlan();
}

/** 根据运行状态锁定配置并切换开始、停止按钮。 */
function setBusy(value) {
  if (!value) stopping = false;
  busy = value; $('fields').disabled = value || !configured; $('start').disabled = value || clearingHistory || savingService || !configured;
  $('serviceFields').disabled = value || savingService || !serviceReady;
  $('history').disabled = value || clearingHistory;
  $('clearHistory').disabled=value||clearingHistory;
  const scheduled = current?.status === 'scheduled';
  $('start').innerHTML = value ? `<span>◌</span> ${scheduled ? '等待预约时间' : current?.status === 'preparing' ? '正在准备测试' : '持续压测正在运行'}` : `<span>▶</span> ${esc($('startMode').value === 'scheduled' ? '预约定时测试' : currentPlan().label)}`;
  $('stop').hidden = false; $('stop').disabled = !value || stopping;
  $('stop').textContent = stopping ? '正在停止并生成报告…' : scheduled ? '取消预约' : '停止并生成报告';
}

/** 把秒格式化为倒计时，零值和缺失值均有限显示。 */
function clock(seconds) {
  const total = Math.max(0, Math.ceil(seconds || 0));
  return total >= 3600 ? `${Math.floor(total/3600)}:${String(Math.floor(total/60)%60).padStart(2,'0')}:${String(total%60).padStart(2,'0')}` : `${String(Math.floor(total/60)).padStart(2,'0')}:${String(total%60).padStart(2,'0')}`;
}

/** 显示自动顺序执行的轮次，区分持续发压和收尾等待。 */
function drawStages(stages, duration) {
  const labels = {pending:'等待开始',running:'持续发压',draining:'在途收尾',completed:'已完成',cancelled:'已停止',failed:'失败',interrupted:'已中断',skipped:'未执行'};
  $('stageStrip').classList.toggle('single-stage', stages.length === 1);
  const durationLabel = duration >= 3600 ? `${Number((duration/3600).toFixed(2))} 小时` : clock(duration);
  $('stageStrip').innerHTML = stages.map((s,i)=>`<div class="stage-item ${esc(s.state || 'pending')}"><span>${stages.length === 1 ? '单档持续测试' : '第 '+(i+1)+' 轮'}</span><strong>${s.concurrency}<small> 并发</small></strong><em>${durationLabel} · ${labels[s.state] || '等待开始'}</em></div>`).join('');
}

/** 刷新历史下拉列表；只保留本地已保存的真实测试。 */
async function loadHistory(selected = current?.id) {
  const runs = await api('/api/runs');
  $('history').innerHTML = '<option value="">历史测试记录</option>' + runs.map(r => `<option value="${esc(r.id)}">${esc(new Date(r.createdAt).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false }))} · C${r.concurrencies.join('/')} · ${esc(({completed:'完成',running:'运行中',warming:'预热中',scheduled:'已预约',preparing:'准备中',cancelled:'已取消',failed:'失败',interrupted:'已中断'})[r.status] || r.status)}</option>`).join('');
  $('history').value = selected || '';
  return runs;
}

/** 绘制每个并发档位的独立合成、下载均值，空样本不伪造数据。 */
function drawChart(stats) {
  const max = Math.max(...stats.flatMap(s => [s.synth.mean || 0, s.download.mean || 0]), 1);
  const w = 720, h = 210, left = 40, bottom = 172, top = 24, area = bottom - top;
  let svg = '';
  for (let i = 0; i <= 4; i++) {
    const y = bottom - area * i / 4;
    svg += `<line x1="${left}" y1="${y}" x2="${w-12}" y2="${y}" stroke="#e9ede5" stroke-dasharray="3 5"/><text x="${left-9}" y="${y+3}" text-anchor="end" fill="#929b8a" font-size="9">${(max/1000*i/4).toFixed(1)}</text>`;
  }
  const span = (w-left-12)/stats.length;
  stats.forEach((s, i) => {
    const center = left + span * (i + .5); const bw = Math.min(40, span * .21);
    [s.synth, s.download].forEach((metric, j) => {
      const value = metric.mean; const bh = (value || 0) / max * area;
      const x = center + (j ? 4 : -bw-4), y = bottom-bh;
      svg += `<rect x="${x}" y="${value === null ? bottom-2 : y}" width="${bw}" height="${value === null ? 2 : Math.max(bh,1)}" rx="2" fill="${value === null ? '#e8ede4' : j ? '#6d96a4' : '#d75c31'}"><title>并发 ${s.concurrency}，${j ? '下载' : '合成'}均值 ${seconds(value)} 秒，${metric.count} 个样本</title></rect>`;
      svg += `<text x="${x+bw/2}" y="${Math.max(12,y-7)}" text-anchor="middle" font-size="9" fill="${j ? '#6d96a4' : '#b75b36'}">${value === null ? '—' : (value/1000).toFixed(2)}</text>`;
    });
    svg += `<text x="${center}" y="198" text-anchor="middle" fill="#687561" font-size="10">并发 ${s.concurrency}</text>`;
  });
  $('chart').innerHTML = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="不同并发下的合成和下载平均耗时，单位秒">${svg}</svg>`;
}

/** 下载失败集中显示；完整 URL 可复制或打开，用户取消不混入失败列表。 */
function renderDownloadFailures(run) {
  const analysis=run.downloadFailureAnalysis || analyzeDownloadFailures(run);
  $('downloadFailureCount').textContent=`${analysis.total} 失败 · ${analysis.timeouts} 超时`;
  $('exportDownloadFailures').disabled=!analysis.total;
  $('downloadFailureNote').textContent=`以下是客户端观测到的失败阶段，不直接认定远端根因。用户取消下载 ${analysis.cancelled} 条，单列统计；历史缺少阶段记录 ${analysis.unknown} 条。页面最多显示最近 100 条，导出报告包含全部。`;
  if (run.config.downloadAudio === false) $('downloadFailureNote').textContent = '本场已关闭下载测试，未发起音频下载，未验证链接可下载性。';
  $('downloadFailureGroups').innerHTML=analysis.groups.map(g=>`<span>${esc(g.label)} <b>${g.count}</b></span>`).join('');
  const kinds={timeout:'超时',network:'网络异常',http:'HTTP 异常',validation:'校验失败'};
  $('downloadFailureBody').innerHTML=analysis.failures.slice(-100).map(r=>{
    const diag=r.downloadDiagnostics,stage=r.downloadFailureStage||'unknown';
    const original=r.audioUrlOriginal||r.audioUrl||'历史未记录',final=r.downloadFinalUrl||diag?.currentUrl||original;
    const link=/^https?:\/\//i.test(original)?`<a href="${esc(original)}" target="_blank" rel="noopener noreferrer">${esc(original)}</a>`:esc(original);
    return `<tr><td>#${r.id} / C${run.stages[r.stage].concurrency}</td><td>${esc(DOWNLOAD_PHASES[stage]||stage)}</td><td>${esc(kinds[r.downloadFailureKind]||(r.timedOut?'超时':'下载失败'))}<br><small>HTTP ${r.downloadHttpStatus||r.httpStatus||'—'}</small></td><td>${r.downloadReceivedBytes??diag?.receivedBytes??'—'} / ${r.downloadExpectedBytes??diag?.expectedBytes??'未知'}</td><td>${seconds(r.downloadAttemptMs)} s</td></tr><tr><td colspan="5" class="failure-url">${link}${final!==original?`<small>最终 URL：${esc(final)}</small>`:''}<small>${esc(r.downloadErrorCode||'历史未记录')} · ${esc(r.error)}</small></td></tr>`;
  }).join('')||'<tr><td colspan="5" class="empty-cell">当前没有下载失败。所有失败记录也会进入导出报告的专项章节。</td></tr>';
}

/** 把真实测试快照渲染为指标、阶梯对比表与逐请求明细。 */
function render(run) {
  if (current?.id !== run.id) {
    $('startMode').value = run.status === 'scheduled' ? 'scheduled' : 'now';
    if (run.config.scheduledAt) {
      const date = new Date(run.config.scheduledAt);
      $('scheduledAt').value = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0,16);
    }
    updateStartMode();
    for (const key of ['voiceId','lang','warmup','speechRate','loudnessRate']) $(key).value = run.config[key];
    $('intervalSilence').value = run.config.intervalSilence ?? 200;
    $('synthTimeout').value = Math.min(Number(run.config.synthTimeout) || 20, 20);
    $('downloadTimeout').value = Math.min(Number(run.config.downloadTimeout) || 10, 10);
    $('downloadAudio').value = String(run.config.downloadAudio ?? false);
    if (run.config.mode === 'duration') {
      const single = run.config.runMode === 'single' || run.config.concurrencies.length === 1;
      $('runMode').value = single ? 'single' : 'ladder';
      if (single) { $('singleConcurrency').value = run.config.concurrencies[0]; $('singleHours').value = run.config.stageSeconds / 3600; }
      else { $('concurrencies').value = run.config.concurrencies.join(','); $('stageMinutes').value = run.config.stageSeconds / 60; }
      updateRunMode();
    }
    $('textSource').value = run.config.textSource || 'manual';
    if ($('textSource').value === 'manual') manualText = run.config.texts.join('\n');
    updateTextSource();
  }
  current = run;
  const active = ['running','warming','scheduled','preparing'].includes(run.status); setBusy(active);
  const scheduled = run.status === 'scheduled';
  const scheduledTime = run.config.scheduledAt ? new Date(run.config.scheduledAt).toLocaleString('zh-CN', {hour12:false}) : '';
  const success = run.results.filter(r => r.status === 'success');
  const attempted = run.results.filter(r => r.startedAt);
  const totals = run.overall || {attempted:attempted.length,success:success.length,failed:run.results.filter(r=>r.status==='failed').length,timedOut:run.results.filter(r=>r.timedOut).length,total:run.results.length};
  const synth = run.overall?.synth || distribution(run.results.filter(r => r.synthOK).map(r => r.synthMs));
  const download = run.overall?.download || distribution(success.map(r => r.downloadMs));
  $('successLabel').textContent = run.config.downloadAudio === false ? '获取链接成功率' : '全流程成功率';
  $('downloadMetricNote').textContent = run.config.downloadAudio === false ? '已跳过下载测试' : 'URL → 完整音频';
  $('mSuccess').innerHTML = totals.attempted ? `${(totals.success/totals.attempted*100).toFixed(1)}<em>%</em>` : '—';
  $('mCount').textContent = `${totals.success} 成功 / ${totals.attempted} 已启动 · ${totals.failed} 失败`;
  $('mSynth').innerHTML = synth.count ? `${seconds(synth.mean)}<em>s</em>` : '—';
  $('mDownload').innerHTML = download.count ? `${seconds(download.mean)}<em>s</em>` : '—';
  $('mP95').innerHTML = synth.count ? `${seconds(synth.p95)}<em>s</em>` : '—';
  const terminal = run.results.filter(r => ['success','failed','cancelled'].includes(r.status)).length;
  const ended = run.endedAt || Date.now();
  const stage = run.stages.find(s => s.startedAt && !s.endedAt);
  const stageSummary = stage ? run.summary[stage.index] : null;
  const timed = run.config.mode === 'duration';
  $('runTitle').textContent = ({scheduled:`已预约 · ${scheduledTime}`,preparing:'正在查询音色，准备开始测试',running:stage ? `${run.config.runMode === 'single' ? '单档持续' : '第 '+(stage.index+1)+' / '+run.stages.length+' 轮'} · ${stage.concurrency} 并发${stageSummary?.state === 'draining' ? ' · 收尾中' : ''}` : '正在切换下一轮',warming:`正在预热 ${run.warmupDone || 0}/${run.config.warmup}`,completed:timed ? run.config.runMode === 'single' ? '单档测试完成，报告已就绪' : '全部轮次完成，汇总报告已就绪' : '历史测试已完成',cancelled:run.config.scheduledAt && !run.startedAt ? '预约已取消，未发起测试' : '压测已停止，已汇总现有结果',failed:'测试失败，已保留结果',interrupted:'服务中断，已保留结果'})[run.status] || run.status;
  $('progressArea').hidden = false;
  const progress = timed ? run.summary.reduce((n,s)=>n+s.admissionSeconds,0) / (run.config.stageSeconds*run.stages.length) : terminal/Math.max(1,totals.total);
  $('progressText').textContent = timed ? `${run.stages.filter(s=>s.state==='completed').length} / ${run.stages.length} 轮完成 · 已发 ${totals.attempted} 条 · 超时 ${totals.timedOut} 条` : `${terminal} 条已结束`;
  $('elapsed').textContent = scheduled ? `距离启动 ${clock((run.config.scheduledAt-Date.now())/1000)}` : stage && timed ? stageSummary?.state === 'draining' ? `在途 ${stage.active || 0} 条，等待超时内收尾` : `本轮剩余 ${clock((stage.deadlineAt-Date.now())/1000)}` : `总用时 ${clock(run.startedAt ? (ended-run.startedAt)/1000 : run.config.scheduledAt ? 0 : (ended-run.createdAt)/1000)}`;
  $('progressFill').style.width = `${Math.min(100,progress*100)}%`;
  drawStages(run.summary, timed ? run.config.stageSeconds : 0);
  $('reportNote').textContent = run.reportsReady ? run.status === 'cancelled' ? '已保存停止时的部分报告：包含已完成结果、在途取消记录及未执行轮次。下方可导出 Markdown、CSV 和 JSON。' : '整场汇总报告已自动保存。下方可导出所有轮次的 Markdown、CSV 和 JSON。' : active ? '本地服务持续运行并自动保存进度；到时自动结束，也可随时点击“停止并生成报告”。' : '当前显示历史结果；新测试采用上方持续时间配置。';
  if (scheduled) $('reportNote').textContent = `将在 ${scheduledTime}（本机时间）启动，包含预热；当前不会发起合成请求。可取消预约，须保持服务运行、电脑唤醒。`;
  if (run.config.downloadAudio === false) $('reportNote').textContent += ' 本场已关闭下载测试，拿到音频链接即成功；全流程耗时截至获取链接，未验证音频能否下载。';
  $('exportMd').textContent = run.status === 'cancelled' ? '↓ 停止报告 .md' : '↓ 汇总报告 .md';
  drawChart(run.summary);
  $('summaryBody').innerHTML = run.summary.map(s => `<tr><td>${s.concurrency} / ${s.peakActive}</td><td>${s.attempted} / ${s.success}</td><td>${s.failed} / ${s.timedOut}</td><td>${clock(s.admissionSeconds)} / ${s.drainSeconds.toFixed(1)}s</td><td>${seconds(s.synth.mean)} s</td><td>${seconds(s.synth.p95)} s</td><td>${seconds(s.download.mean)} s</td><td>${seconds(s.e2e.mean)} s</td><td>${s.rps === null ? '—' : s.rps.toFixed(3)}</td></tr>`).join('');
  $('detailCount').textContent = `${totals.total} 条`;
  const shown = run.results.slice(-200);
  $('detailBody').innerHTML = shown.map(r => `<tr><td>#${String(r.id).padStart(2,'0')}</td><td>${run.stages[r.stage].concurrency}</td><td><span class="status ${esc(r.status)}">${esc(statusLabels[r.status] || r.status)}</span></td><td>${seconds(r.synthMs ?? r.synthAttemptMs)}</td><td>${seconds(r.downloadMs ?? r.downloadAttemptMs)}</td><td>${r.bytes ? (r.bytes/1024).toFixed(1)+' KB' : '—'}</td><td>${r.localAudio ? `<button class="audio-link" data-audio="${r.id}">▶ 试听</button>` : ''}${/^https?:\/\//i.test(r.audioUrl || '') ? `<a class="remote-link" href="${esc(r.audioUrl)}" target="_blank" rel="noopener noreferrer">URL ↗</a>` : r.localAudio ? '' : '—'}</td></tr>${r.error ? `<tr class="error-row"><td colspan="7">${esc(r.phase || 'queue')} ${r.httpStatus ? 'HTTP '+r.httpStatus : ''} · ${esc(r.error)}</td></tr>` : ''}`).join('');
  const truncated = totals.total > 200;
  if (truncated) $('detailBody').insertAdjacentHTML('afterbegin', '<tr><td colspan="7" class="empty-cell">页面显示最近 200 条；导出包含所有轮次全部请求。</td></tr>');
  const displayedRows = $('detailBody').querySelectorAll('tr:not(.error-row)');
  shown.forEach((row, index) => {
    const tableRow = displayedRows[index + (truncated ? 1 : 0)];
    tableRow?.insertAdjacentHTML('afterend', `${renderAudioUrlRecord(row,run.config)}${row.text?`<tr class="text-row"><td colspan="7"><span>${row.textChars} 字${row.sourceRecord ? ' · CSV 记录 #'+row.sourceRecord : ''}</span>${esc(row.text)}</td></tr>`:''}`);
  });
  for (const id of ['exportMd','exportCsv','exportJson']) $(id).disabled = false;
  renderDownloadFailures(run);
  if (run.error) notice(run.error + (run.warmupError ? '：' + run.warmupError : ''));
  if (run.persistenceError) notice('本地报告保存异常：'+run.persistenceError+'。可使用下方导出按钮保存当前内存中的结果。');
}

/** 顺序轮询任务状态，连接暂时中断时保留已有结果并自动恢复。 */
async function poll(id) {
  clearTimeout(timer);
  try {
    const run = await api(`/api/runs/${encodeURIComponent(id)}?compact=1`); pollFailures = 0; notice(); render(run);
    if (['running','warming','scheduled','preparing'].includes(run.status)) timer = setTimeout(() => poll(id), 800);
    else await loadHistory(id);
  } catch (e) {
    pollFailures++;
    if (pollFailures >= 3) {
      notice('连续 3 次无法读取测试状态，已停止自动等待。请刷新页面重连；本地任务状态尚未确认。');
      $('runTitle').textContent = '连接中断，已停止自动等待'; return;
    }
    notice('读取测试状态失败：' + e.message + `，正在重连（${pollFailures}/3）。`);
    timer = setTimeout(() => poll(id), 2500);
  }
}

/** 提交一组真实阶梯并发请求，不把 API Key 放入表单。 */
async function startTest(event) {
  event.preventDefault(); if (busy || savingService) return;
  if ($('ttsBaseUrl').value.trim().replace(/\/+$/, '') !== activeBaseUrl.replace(/\/+$/, '')) { notice('TTS 地址尚未保存，请先点击“保存地址”。'); return; }
  const input = Object.fromEntries(new FormData($('configForm')));
  input.downloadAudio = input.downloadAudio === 'true';
  if (input.runMode === 'single') { input.concurrencies = input.singleConcurrency; input.stageSeconds = Number(input.singleHours) * 3600; }
  if (input.textSource === 'manual') manualText = input.text;
  if ($('startMode').value === 'scheduled') {
    const date = new Date($('scheduledAt').value);
    if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) { notice('请选择晚于当前时间的预约时间'); return; }
    input.scheduledAt = date.toISOString();
  }
  stopping = false; notice(); setBusy(true);
  try {
    const { id } = await api('/api/runs', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(input) });
    await loadHistory(id); await poll(id);
  } catch (e) { notice(e.message); setBusy(false); }
}

/** 请求取消当前任务；后续轮询等待在途连接结束。 */
async function stopTest() {
  if (!current || !busy || stopping) return;
  stopping = true; setBusy(true);
  try { await api(`/api/runs/${current.id}/stop`, { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' }); await poll(current.id); }
  catch (e) { stopping = false; notice(e.message); setBusy(true); }
}

/** 下载本地服务生成的报告，包含当前全部数据。 */
function exportReport(format) {
  if (!current) return;
  const link = document.createElement('a'); link.href = `/api/runs/${current.id}/${format==='download-failures.csv'?format:'report.'+format}`; link.download = `indextts-${current.id}.${format}`;
  document.body.append(link); link.click(); link.remove();
}

/** 清空历史后重置结果区域，保留测试配置与文本语料。 */
function resetHistoryView() {
  clearTimeout(timer);current=null;pollFailures=0;stopping=false;
  $('player').pause();$('player').removeAttribute('src');$('audioPreview').hidden=true;
  $('progressArea').hidden=true;$('runTitle').textContent='历史已清空，准备开始测试';
  $('reportNote').textContent='历史报告和抽样音频已移入本机归档，可开始新的随机音色测试。';
  for(const id of ['mSuccess','mSynth','mDownload','mP95'])$(id).textContent='—';
  $('mCount').textContent='等待新测试';$('detailCount').textContent='0 条';
  $('detailBody').innerHTML='<tr><td colspan="7" class="empty-cell">历史已清空，等待新测试。</td></tr>';
  $('summaryBody').innerHTML='<tr><td colspan="9" class="empty-cell">开始后自动执行所有轮次</td></tr>';
  $('downloadFailureBody').innerHTML='<tr><td colspan="5" class="empty-cell">当前没有下载失败。</td></tr>';
  $('downloadFailureCount').textContent='0 失败';$('downloadFailureGroups').innerHTML='';
  $('downloadFailureNote').textContent='失败时保留下载 URL、最后观测阶段和字节进度。';
  for(const id of ['exportMd','exportCsv','exportJson','exportDownloadFailures'])$(id).disabled=true;
  drawChart([]);updatePlan();
}

/** 一键清空历史列表；服务端归档文件并拒绝清空仍在运行的测试。 */
async function clearHistory() {
  if(busy||clearingHistory)return;
  clearingHistory=true;setBusy(false);notice();
  try {
    const result=await api('/api/history/clear',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    resetHistoryView();await loadHistory();
    notice(`已清空 ${result.cleared} 场历史。${result.archivePath?'报告和抽样音频可在此归档目录找回：'+result.archivePath:'当前没有需要归档的文件。'}`);
  } catch(error) {notice(error.message);}
  finally {clearingHistory=false;setBusy(busy);}
}

/** 保存基础地址并刷新音色信息，失败时继续显示当前生效地址。 */
async function saveService(event) {
  event.preventDefault(); if (busy || savingService || !serviceReady) return;
  savingService = true; setBusy(busy);
  $('serviceStatus').textContent = '正在保存地址…';
  try {
    const result = await api('/api/config', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ baseUrl:$('ttsBaseUrl').value }) });
    activeBaseUrl = result.baseUrl;
    $('baseUrl').textContent = activeBaseUrl; $('ttsBaseUrl').value = activeBaseUrl;
    $('serviceStatus').textContent = '地址已保存并生效，无需重启。';
    void loadVoiceInfo();
  } catch (error) { $('serviceStatus').textContent = '保存失败：' + error.message; }
  finally { savingService = false; setBusy(busy); }
}

/** 展示当前地址的可用音色数量，忽略切换地址前仍在途的旧查询。 */
async function loadVoiceInfo() {
  const version = ++voiceInfoVersion;
  $('voicePoolInfo').textContent = '正在查询当前服务的可用音色…';
  try {
    const result=await api('/api/voices');
    if (version !== voiceInfoVersion) return;
    $('voicePoolInfo').textContent=`可用 ${result.voices.length} 个音色；每条请求随机选择，打乱后逐条使用，用尽后再打乱。${result.voices.length===1?'当前只有一个可用音色。':''}\n示例：${result.voices.slice(0,3).map(v=>v.voiceName).join('、')}`;
  } catch(error) {if (version === voiceInfoVersion) $('voicePoolInfo').textContent='暂未获取可用音色：'+error.message+'。开始测试时会重新查询。';}
}

/** 通过一个共享播放器试听已下载音频，不重新访问远端 URL。 */
function previewAudio(event) {
  const button = event.target.closest('[data-audio]'); if (!button || !current) return;
  $('audioPreview').hidden = false; $('audioLabel').textContent = `请求 #${button.dataset.audio}`;
  $('player').src = `/api/runs/${current.id}/audio/${button.dataset.audio}`;
  $('player').play().catch(() => notice('请使用播放器的播放按钮试听。'));
}

/** 载入凭据可用状态与最近任务，并绑定界面事件。 */
async function init() {
  $('serviceForm').addEventListener('submit', saveService);
  $('ttsBaseUrl').addEventListener('input', () => { $('serviceStatus').textContent = '地址尚未保存。'; });
  $('configForm').addEventListener('submit', startTest);
  $('configForm').addEventListener('input', updatePlan);
  $('runMode').addEventListener('change', updateRunMode);
  $('startMode').addEventListener('change', updateStartMode);
  $('downloadAudio').addEventListener('change', updatePlan);
  $('textSource').addEventListener('change', () => { if (!$('text').readOnly) manualText = $('text').value; updateTextSource(); });
  $('stop').addEventListener('click', stopTest);
  $('clearHistory').addEventListener('click',clearHistory);
  $('detailBody').addEventListener('click', previewAudio);
  $('closeAudio').addEventListener('click', () => { $('player').pause(); $('audioPreview').hidden = true; });
  $('history').addEventListener('change', async () => { const id = $('history').value; if (id) { notice(); await poll(id); } });
  for (const format of ['Md','Csv','Json']) $('export'+format).addEventListener('click', () => exportReport(format.toLowerCase()));
  $('exportDownloadFailures').addEventListener('click',()=>exportReport('download-failures.csv'));
  updatePlan();
  try {
    const config = await api('/api/config'); configured = config.hasKey; corpusInfo = config.textCorpus;
    if (!corpusInfo?.count) { $('textSource').value = 'manual'; $('textSource').querySelector('option[value="csv"]').disabled = true; }
    updateTextSource();
    $('connection').textContent = configured ? '本地服务在线 · 凭据已加载' : '本地服务在线 · 未配置凭据';
    $('connection').className = 'connection ' + (configured ? 'ready' : 'bad');
    activeBaseUrl = config.baseUrl; $('baseUrl').textContent = activeBaseUrl; $('ttsBaseUrl').value = activeBaseUrl; $('voiceId').value = config.voiceId||'';
    if(!config.features?.randomVoices||!config.features?.clearHistory||!config.features?.scheduledStart||!config.features?.editableBaseUrl||!config.features?.optionalAudioDownload||!config.features?.configurableIntervalSilence) {
      configured=false;setBusy(false);$('clearHistory').disabled=true;
      notice('当前服务版本较旧，请重启本地服务，再使用段间静音配置和下载测试开关。');return;
    }
    serviceReady = true;
    if(config.features?.randomVoices)void loadVoiceInfo();
    setBusy(false);
    const history = await loadHistory();
    const latest = history.find(r => ['running','warming','scheduled','preparing'].includes(r.status)) || history.find(r=>r.mode==='duration');
    if (latest) await poll(latest.id);
    if (!configured) notice('请在启动服务前配置 TTS_API_KEY，或用 TTS_DOC_PATH 指定含 Key 的原始文档。');
  } catch (e) { $('connection').textContent = '本地服务连接失败'; notice(e.message); }
}
init();
