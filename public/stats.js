/** 计算成功样本的均值、最近秩百分位和极值，空样本返回 null。 */
export function distribution(values) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return { count: 0, mean: null, p50: null, p95: null, min: null, max: null };
  return { count: a.length, mean: a.reduce((x, y) => x + y, 0) / a.length,
    p50: a[Math.ceil(a.length * .50) - 1], p95: a[Math.ceil(a.length * .95) - 1], min: a[0], max: a.at(-1) };
}

/** 汇总所有档位，区分发压窗口和在途请求收尾，并保留阶段成功样本口径。 */
export function summarize(run) {
  return run.stages.map(stage => {
    const rows = run.results.filter(r => r.stage === stage.index);
    const success = rows.filter(r => r.status === 'success');
    const synth = rows.filter(r => r.synthOK);
    const attempted = rows.filter(r => r.startedAt);
    const elapsed = stage.startedAt ? Math.max(0, (stage.endedAt || Date.now()) - stage.startedAt) : 0;
    const seconds = stage.endedAt && Number.isFinite(stage.elapsedMs) ? stage.elapsedMs / 1000 : elapsed / 1000;
    const timed = run.config?.mode === 'duration';
    const admissionSeconds = timed ? Math.min(seconds, run.config.stageSeconds) : seconds;
    const state = stage.endedAt ? (stage.state || 'completed') : !stage.startedAt ? (stage.state === 'skipped' ? 'skipped' : 'pending') :
      timed && Date.now() >= stage.deadlineAt ? 'draining' : 'running';
    return { concurrency: stage.concurrency, peakActive: stage.peakActive || 0, active: stage.active || 0,
      state, total: rows.length, attempted: attempted.length, success: success.length, synthSuccess: synth.length,
      failed: rows.filter(r => r.status === 'failed').length, timedOut: rows.filter(r => r.timedOut).length,
      cancelled: rows.filter(r => r.status === 'cancelled').length, pending: rows.filter(r => r.status === 'pending').length,
      seconds, admissionSeconds, drainSeconds: Math.max(0, seconds - admissionSeconds),
      successRate: attempted.length ? success.length / attempted.length : null,
      rps: seconds ? success.length / seconds : null,
      synth: distribution(synth.map(r => r.synthMs)), download: distribution(success.map(r => r.downloadMs)),
      ttfb: distribution(success.map(r => r.downloadTtfbMs)), e2e: distribution(success.map(r => r.e2eMs)),
      textChars: distribution(attempted.map(r => r.textChars)), bytes: success.reduce((n, r) => n + (r.bytes || 0), 0) };
  });
}

/** 将毫秒显示为秒，空样本保持缺失标记。 */
export function seconds(ms) { return Number.isFinite(ms) ? (ms / 1000).toFixed(3) : '—'; }

export const DOWNLOAD_PHASES = {
  url_validation:'URL 校验',waiting_socket:'等待可用连接',dns_lookup:'DNS 域名解析',tcp_connect:'TCP 连接',
  tls_handshake:'TLS 握手',request_send:'请求发送',waiting_response:'等待 HTTP 响应头',
  waiting_first_byte:'等待音频首字节',body_read:'响应体读取',redirect:'重定向处理',http_status:'HTTP 状态异常',
  validation:'音频内容校验',complete:'下载已完成',unknown:'历史未记录/无法定位'
};

/** 只分析真正的下载失败，主动取消单列，旧记录缺少诊断时不推断阶段。 */
export function analyzeDownloadFailures(run,limit=Infinity) {
  const all=run.results.filter(r=>r.status==='failed'&&(r.phase==='download'||r.downloadFailureStage));
  const groups=new Map();
  for(const row of all) {
    const stage=row.downloadFailureStage || 'unknown';
    if(!groups.has(stage))groups.set(stage,{stage,label:DOWNLOAD_PHASES[stage]||stage,count:0,timeouts:0});
    const group=groups.get(stage);group.count++;if(row.timedOut)group.timeouts++;
  }
  return {total:all.length,timeouts:all.filter(r=>r.timedOut).length,unknown:all.filter(r=>!r.downloadFailureStage||r.downloadFailureStage==='unknown').length,
    cancelled:run.results.filter(r=>r.status==='cancelled'&&r.phase==='download').length,
    groups:[...groups.values()].sort((a,b)=>b.count-a.count),failures:Number.isFinite(limit)?all.slice(-limit):all};
}

/** 为每条下载失败输出 URL、观测阶段、字节进度、重定向链和事件时间线。 */
function downloadFailureChapter(run) {
  if (run.config.downloadAudio === false) return ['## 下载失败专项分析', '', '本场已关闭下载测试，未发起音频下载，未验证链接可下载性。', ''];
  const analysis=analyzeDownloadFailures(run);
  const kinds={timeout:'超时',network:'网络异常',http:'HTTP 异常',validation:'内容/URL 校验失败'};
  const lines=['## 下载失败专项分析','',`- 下载失败：${analysis.total} 条，其中超时 ${analysis.timeouts} 条。`,
    `- 用户取消的下载：${analysis.cancelled} 条，单独记录，不作为下载失败或超时。`,
    '- 以下阶段是客户端最后观测到的状态，不能仅凭此认定服务端、代理或网络中的具体根因。',
    '- 下载总时限仍从初始 GET 发起计算；重定向不重置已配置的下载倒计时；历史记录没有分阶段数据时标记为“历史未记录”。',''];
  if(!analysis.total) {lines.push('本次没有下载失败。','');return lines;}
  lines.push('| 最后观测阶段 | 失败数 | 其中超时 |','|---|---:|---:|',
    ...analysis.groups.map(g=>`| ${g.label} | ${g.count} | ${g.timeouts} |`),'');
  for(const row of analysis.failures) {
    const diag=row.downloadDiagnostics,stage=row.downloadFailureStage||'unknown';
    lines.push(`### 下载失败请求 #${row.id} · 并发 ${run.stages[row.stage].concurrency}`,'',
      `- 类型：${kinds[row.downloadFailureKind] || (row.timedOut?'超时':'下载失败')}；最后观测阶段：${DOWNLOAD_PHASES[stage]||stage}`,
      `- 错误码：${md(row.downloadErrorCode || '历史未记录')}；错误信息：${md(row.error)}`,
      `- 原始下载 URL：${md(row.audioUrlOriginal || row.audioUrl || audioUrlMissingReason(row))}`,
      `- 下载请求 URL：${md(row.downloadRequestUrl || '未发起/历史未记录')}`,
      `- 最终请求 URL：${md(row.downloadFinalUrl || diag?.currentUrl || row.audioUrl || '历史未记录')}`,
      `- HTTP 状态：${row.downloadHttpStatus || row.httpStatus || '尚未收到/历史未记录'}；Content-Type：${md(row.downloadContentType || diag?.contentType || '未知')}`,
      `- 下载尝试耗时：${seconds(row.downloadAttemptMs)} 秒；响应头到达：${seconds(diag?.responseHeadersMs)} 秒；音频首字节到达：${seconds(diag?.firstByteMs)} 秒（均相对初始 GET）`,
      `- 已接收：${row.downloadReceivedBytes ?? diag?.receivedBytes ?? '历史未记录'} 字节；Content-Length 预计长度：${row.downloadExpectedBytes ?? diag?.expectedBytes ?? '未知'} 字节`,
      `- 连接：${diag ? diag.reusedConnection?'复用已有连接，DNS/TCP/TLS 不重复发生':'新连接流程（可能未完成）' : '历史未记录'}；远端地址：${md(diag?.remoteAddress || '未知')}`);
    if(diag?.redirects?.length)lines.push('- 重定向链：',...diag.redirects.map(r=>`  - HTTP ${r.status}：${md(r.from)} → ${md(r.to)}（${seconds(r.atMs)} 秒）`));
    if(diag?.events?.length)lines.push('- 客户端阶段时间线：'+diag.events.map(e=>`${DOWNLOAD_PHASES[e.phase]||e.phase} @ ${seconds(e.atMs)}s`).join(' → '));
    if(diag?.phaseDurationsMs)lines.push('- 各阶段累计耗时：'+Object.entries(diag.phaseDurationsMs).map(([p,ms])=>`${DOWNLOAD_PHASES[p]||p} ${seconds(ms)}s`).join('；'));
    lines.push('');
  }
  return lines;
}

/** 转义 Markdown 表格内的外部文本，防止换行或竖线破坏表格。 */
function md(value) { return String(value ?? '—').replaceAll('|', '\\|').replace(/\r?\n/g, ' '); }

/** 将 HTTP 音频地址输出为完整可点击链接，缺失或异常地址保留文字标记。 */
function audioUrlLink(value) {
  if (!value) return '历史未记录';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return md(value);
    return `<${url.href.replace(/[<>\s|]/g, char => encodeURIComponent(char))}>`;
  } catch { return md(value); }
}

/** 区分没有拿到音频地址与历史未采集，避免为合成失败或取消请求虚构链接。 */
export function audioUrlMissingReason(row) {
  if (row.audioUrlOriginal || row.audioUrl) return '';
  if (row.status === 'pending' || !row.startedAt) return '请求未启动，未获取音频 URL';
  if (row.synthOK) return '历史未记录音频 URL';
  if (row.status === 'cancelled') return '合成结束前取消，未获取音频 URL';
  if (row.status === 'failed') return row.synthHttpStatus === 201 ? '合成响应未返回有效音频 URL' : '合成失败，未获取音频 URL';
  if (row.status === 'synthesizing') return '等待合成响应，尚未获取音频 URL';
  return '历史未记录音频 URL';
}

/** 为所有请求保留完整音频 URL，并关联新文档的存储、字幕及服务端诊断信息。 */
function audioDeliveryChapter(run) {
  const status={success:'成功',failed:'失败',cancelled:'取消',pending:'未启动',synthesizing:'合成中',downloading:'下载中'};
  const lines=['## 全部请求音频 URL','',
    '覆盖成功、失败、取消及尚未结束的全部正式请求；只要收到音频 URL 就保留，完整查询参数不截断。未收到 URL 时注明原因。最终地址仅使用实际观测值。','',
    '| 请求 | 并发 | 结果 | 原始返回音频 URL | 下载请求 URL | 最终下载 URL |',
    '|---:|---:|---|---|---|---|',
    ...run.results.map(r=>`| ${r.id} | ${run.stages[r.stage].concurrency} | ${status[r.status]||md(r.status)} | ${r.audioUrlOriginal||r.audioUrl?audioUrlLink(r.audioUrlOriginal||r.audioUrl):audioUrlMissingReason(r)} | ${r.downloadRequestUrl?audioUrlLink(r.downloadRequestUrl):'未发起/历史未记录'} | ${r.downloadFinalUrl?audioUrlLink(r.downloadFinalUrl):'尚未观测/历史未记录'} |`),'',
    '## 字幕与存储交付','',
    '仅记录合成响应中的字幕和交付信息，不额外下载 SRT，不增加并发槽位内的下载任务。服务端时长字段是音频长度，不能当作推理耗时；URL 是否仍有效取决于实际存储及过期策略。','',
    '| 请求 | 音频 ID | 音频存储 | 创建 / 过期时间 | 服务端音频长度(ms) / 字节 | 字幕模式 / 存储 / 条数 | 字幕 URL |',
    '|---:|---|---|---|---|---|---|',
    ...run.results.map(r=>`| ${r.id} | ${md(r.audioId)} | ${md(r.audioStorage)} | ${md(r.audioCreatedAt)} / ${r.audioExpiresAt===null?'未提供到期时间（不代表永久）':md(r.audioExpiresAt)} | ${r.serverAudioDurationMs??'—'} / ${r.serverAudioSizeBytes??'—'} | ${md(r.subtitleMode)} / ${md(r.subtitleStorage)} / ${r.subtitleCount??'—'} | ${r.subtitleUrl?audioUrlLink(r.subtitleUrl):'未返回/历史未记录'} |`),'',
    '## 服务端诊断','',
    '以下响应头是可选诊断信息，未返回时显示“—”；Server-Timing 保留服务端原文，不推断缺失阶段，也不据此自动重试。','',
    '| 请求 | X-Request-ID | X-TTS-Worker | X-TTS-Batch-ID | X-TTS-Batch-Size | Server-Timing | Retry-After |',
    '|---:|---|---|---|---|---|---|',
    ...run.results.map(r=>`| ${r.id} | ${md(r.requestId)} | ${md(r.ttsWorker)} | ${md(r.ttsBatchId)} | ${md(r.ttsBatchSize)} | ${md(r.serverTiming)} | ${md(r.retryAfter)} |`),''];
  return lines;
}

/** 展示可复现的音色池与逐音色结果，随机混合音色的耗时按实际样本解释。 */
function voiceAssignmentChapter(run) {
  const pool=new Map((run.config.voicePool||[]).map(v=>[v.voiceId,v.voiceName]));
  for(const row of run.results)if(row.voiceId||run.config.voiceId)pool.set(row.voiceId||run.config.voiceId,row.voiceName||pool.get(row.voiceId)||row.voiceId||run.config.voiceId);
  const lines=['## 音色分配','',run.config.voiceMode==='random'?
    `随机音色池 ${run.config.voicePool?.length||0} 个；随机种子 ${run.config.voiceSamplingSeed}。每轮打乱后逐条使用，用尽再打乱；各并发档位复用相同音色序列，预热独立抽取。`:
    `固定音色/历史配置：${md(run.config.voiceId)}。`,'',
    '音色查询在正式计时前完成；音色不同可能影响耗时，整场指标代表该音色池的混合结果。','',
    '| 音色 ID | 名称 | 已启动 | 成功 | 失败 | 取消 |','|---|---|---:|---:|---:|---:|'];
  for(const [id,name] of pool) {
    const rows=run.results.filter(r=>(r.voiceId||run.config.voiceId)===id&&r.startedAt);
    lines.push(`| ${md(id)} | ${md(name)} | ${rows.length} | ${rows.filter(r=>r.status==='success').length} | ${rows.filter(r=>r.status==='failed').length} | ${rows.filter(r=>r.status==='cancelled').length} |`);
  }
  return [...lines,''];
}

/** 使用固定北京时间显示报告时间。 */
function date(value) { return value ? new Date(value).toLocaleString('zh-CN', { timeZone:'Asia/Shanghai', hour12:false }) : '—'; }

/** 生成一份包含整场总览、五档对比、失败和全部明细的汇总报告。 */
export function markdownReport(run) {
  const stats = summarize(run), timed = run.config.mode === 'duration';
  const downloadAudio = run.config.downloadAudio !== false;
  const source = run.config.textCorpus;
  const totals = stats.reduce((a, s) => ({ attempted:a.attempted+s.attempted, success:a.success+s.success,
    failed:a.failed+s.failed, timedOut:a.timedOut+s.timedOut, cancelled:a.cancelled+s.cancelled }),
    {attempted:0,success:0,failed:0,timedOut:0,cancelled:0});
  const successful = run.results.filter(r => r.status === 'success');
  const synth = distribution(run.results.filter(r => r.synthOK).map(r => r.synthMs));
  const download = distribution(successful.map(r => r.downloadMs));
  const complete = stats.filter(s => s.state === 'completed' && s.success > 0);
  const best = complete.reduce((a, s) => !a || s.rps > a.rps ? s : a, null);
  const errors = run.results.filter(r => ['failed','cancelled'].includes(r.status)&&!(r.status==='failed'&&(r.phase==='download'||r.downloadFailureStage)));
  const samples = source ? [...new Map((run.config.textSamples || run.results).filter(r=>r.sourceId || r.sourceRecord)
    .map(r=>[r.sourceId || r.sourceRecord,r])).values()] : [];
  const lines = [
    timed ? run.config.runMode === 'single' ? '# IndexTTS 单档持续并发测试报告' : '# IndexTTS 持续并发压测汇总报告' : '# IndexTTS 并发测试报告', '',
    `- 测试编号：${run.id}`, `- 状态：${run.status}`,
    ...(run.config.scheduledAt ? [`- 预约创建时间：${date(run.createdAt)}（北京时间）`, `- 预约启动时间：${date(run.config.scheduledAt)}（北京时间）`,
      `- 实际开始时间（含预热）：${run.startedAt ? date(run.startedAt) : '尚未开始'}`] : [`- 开始时间：${date(run.startedAt || run.createdAt)}（北京时间）`]),
    `- 结束时间：${date(run.endedAt)}`, `- 接口：POST ${run.baseUrl}/api/v1/tts/synthesize`,
    ...(run.error ? [`- 任务说明：${md(run.error)}`] : []),
    ...(run.status === 'cancelled' ? [`- 停止原因：${md(run.stopReason || '任务已取消')}`, `- 停止时间：${date(run.stopRequestedAt || run.endedAt)}`,
      '- 报告范围：部分结果（已完成请求及在途取消记录）；未执行轮次不记为已完成。'] : []),
    `- 音色：${run.config.voiceMode==='random'?`每条随机（${run.config.voicePool?.length||0} 个可用音色）`:run.config.voiceId}`, `- 语言：${run.config.lang}；语速：${run.config.speechRate}；音量：${run.config.loudnessRate}`,
    `- 段间静音（interval_silence）：${run.config.intervalSilence == null ? '历史未记录（未显式发送）' : run.config.intervalSilence + ' 毫秒'}`,
    `- 并发阶梯：${run.config.concurrencies.join(' → ')}`,
    ...(run.config.runMode === 'single' ? [`- 单档设置：${run.config.concurrencies[0]} 并发，持续 ${run.config.stageSeconds / 3600} 小时`] : []),
    timed ? `- 每档持续发压：${run.config.stageSeconds} 秒；计划发压合计 ${run.config.stageSeconds * run.stages.length / 60} 分钟；各档收尾另计` :
      `- 每档计划请求数：${run.config.requests}`,
    `- 串行预热：${run.config.warmup} 次（不计统计）`,
    `- 测试音频下载：${downloadAudio ? '开启（合成并下载音频）' : '关闭（拿到音频链接即成功）'}`,
    `- 超时：合成 ${run.config.synthTimeout} 秒，下载 ${downloadAudio ? run.config.downloadTimeout + ' 秒' : '未测试'}`,
    `- 请求音频交付：${run.config.audioDelivery || '历史未记录'}；用途：${run.config.audioPurpose || '历史未记录'}；实际存储以每条响应的 audio_storage 为准`,
    `- 文本来源：${source ? `${source.sourceFile}，${source.column}列；${source.count} 条有效语料` : '手动输入'}`,
    ...(source ? [`- 抽样种子：${run.config.samplingSeed}`, `- 语料 SHA256：${source.corpusSha256}`, `- 原始 CSV SHA256：${source.sourceSha256}`] : []), '',
    '## 整场汇总', '',
    `- 已启动：${totals.attempted}；成功：${totals.success}；失败：${totals.failed}（其中超时 ${totals.timedOut}）；取消：${totals.cancelled}`,
    `- ${downloadAudio ? '全流程' : '获取链接'}成功率：${totals.attempted ? (totals.success/totals.attempted*100).toFixed(2)+'%' : '—'}`,
    `- 合成均值 / P50 / P95：${seconds(synth.mean)} / ${seconds(synth.p50)} / ${seconds(synth.p95)} 秒`,
    `- 下载均值 / P95：${seconds(download.mean)} / ${seconds(download.p95)} 秒`,
    best ? `- 本轮已完成档位中最高成功吞吐量：并发 ${best.concurrency}，${best.rps.toFixed(3)} 次/秒。` : '- 尚无已完成且成功的档位。', '',
    '## 各档对比', '', downloadAudio ? '时间单位为秒。超时计入失败；成功要求合成及完整音频下载、内容校验均通过。' : '时间单位为秒。超时计入失败；成功要求合成成功并返回音频链接，不验证链接可下载性。下载指标无样本，显示“—”。', '',
    '| 并发/峰值 | 状态 | 发压/收尾 | 已启动 | 成功 | 失败/超时 | 合成均值 | 合成 P50 | 合成 P95 | 下载均值 | 下载 P95 | 全流程均值 | 成功 RPS | 平均字数 |',
    '|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...stats.map(s=>`| ${s.concurrency}/${s.peakActive} | ${s.state} | ${s.admissionSeconds.toFixed(2)}/${s.drainSeconds.toFixed(2)} | ${s.attempted} | ${s.success} | ${s.failed}/${s.timedOut} | ${seconds(s.synth.mean)} | ${seconds(s.synth.p50)} | ${seconds(s.synth.p95)} | ${seconds(s.download.mean)} | ${seconds(s.download.p95)} | ${seconds(s.e2e.mean)} | ${s.rps?.toFixed(3) ?? '—'} | ${s.textChars.mean?.toFixed(1) ?? '—'} |`), '',
    '## 执行与测量口径', '',
    ...(timed ? [
      '- 每档为固定并发工作池：请求完成或超时后立即补位，持续发起请求至该档计时截止；总请求数随响应速度变化，不预设次数。',
      `- 到时停止新增请求，等待本档在途请求按原有超时限制结束，再自动进入下一档；各档在途请求不重叠。单条网络等待合计最多 ${downloadAudio ? 30 : 20} 秒，因此总时长为计划发压时长加各档收尾。`,
      '- 新请求遇到失败后，该槽位最多间隔 1 秒再取新文本发起下一条请求；不自动重试原请求。冷却包含在档位墙钟中。',
      '- CSV 语料按种子洗牌后依次使用，用尽后重新洗牌循环；每个档位从相同序列起点取词，快慢不同的档位最终请求数可以不同。',
      downloadAudio ? '- 每档仅保留前 3 条成功下载且对应请求序号不大于 3 的本地录音；所有请求均完整下载并计时，全部原始文本与计时保留。' : '- 预热和正式测试均跳过音频下载、内容校验及本地录音保存；保留返回的音频链接和合成元数据。',
      '- 任务由本地服务执行，关闭页面不会停止任务；退出本地服务或电脑休眠会影响测试。进行中每 5 秒保存一次快照，结束后自动保存整场 Markdown、CSV、JSON。'
    ] : ['- 各档固定请求数，按并发工作池顺序执行；不自动重试。', '- 各并发档位复用同组文本序列。']),
    '- 合成耗时：本地服务发起 POST 至完整 JSON 读取结束；包含连接、服务端排队、推理、可能的字幕对齐/存储交付及传输，不能分离纯模型推理时间。',
    ...(downloadAudio ? ['- 下载耗时：音频 URL GET 开始至完整响应体读入内存；包含重定向，不包含写盘。下载请求不携带 API Key。',
      '- 下载 TTFB：从 GET 开始到最终响应的第一个非空数据块；JSON/CSV 明细包含此项。',
      '- 全流程耗时：单条请求开始合成至音频读取并校验完成；不含本地排队和写盘。'] : [
      '- 下载耗时和 TTFB：未测试，留空，不以 0 毫秒计入统计。',
      '- 全流程耗时：单条请求开始合成至获取音频链接；不含音频下载。预热同样只要求获取链接。']),
    '- 成功 RPS = 档位全流程成功数 / 档位实际墙钟时长，包含收尾、调度、失败冷却和抽样录音写盘；成功率分母为已启动请求数。',
    '- 合成分位数只包含合成成功样本；下载及全流程分位数只包含全流程成功样本。失败尝试耗时不混入成功分位数。',
    '- 百分位采用最近秩算法（nearest-rank）；发压截止和请求计时使用单调时钟。',
    '- 结果代表本机网络和当时服务负载；本工具未验证缓存命中，不把最高观测 RPS 当作容量上限。',
    '- 超时或用户停止只取消本地连接，不保证服务端推理终止。', '',
    ...voiceAssignmentChapter(run),
    ...audioDeliveryChapter(run),
    ...downloadFailureChapter(run),
    '## 其他失败与取消', '',
    ...(errors.length ? errors.map(r=>`- #${r.id}，并发 ${run.stages[r.stage].concurrency}，${r.status}，${r.phase || 'queue'}，HTTP ${r.httpStatus || '—'}：${md(r.error)}`) : ['无。']),
    ...(run.warmupError ? ['', '预热失败：'+md(run.warmupError)] : []),
    ...(run.persistenceError ? ['', '本地保存异常：'+md(run.persistenceError)] : []), '',
    '## 请求明细', '',
    '| 请求 | 并发 | 档内序号 | 状态 | 音色 ID / 名称 | 超时 | 合成(s) | 下载(s) | 全流程(s) | 字数 | CSV记录号 | 文本 |',
    '|---:|---:|---:|---|---|---|---:|---:|---:|---:|---:|---|',
    ...run.results.map(r=>`| ${r.id} | ${run.stages[r.stage].concurrency} | ${r.stageRequest ?? '—'} | ${r.status} | ${md(r.voiceId||run.config.voiceId)} / ${md(r.voiceName)} | ${r.timedOut ? '是' : ''} | ${seconds(r.synthMs ?? r.synthAttemptMs)} | ${seconds(r.downloadMs ?? r.downloadAttemptMs)} | ${seconds(r.e2eMs)} | ${r.textChars ?? '—'} | ${r.sourceRecord ?? '—'} | ${md(r.text)} |`),
    ...(source ? ['', '## 抽样来源明细', '', '| CSV 记录号（不含表头） | 媒体 ID | 字数 | 文本 |', '|---:|---|---:|---|',
      ...samples.map(s=>`| ${s.sourceRecord} | ${md(s.sourceId)} | ${Array.from(s.text).length} | ${md(s.text)} |`)] : []), ''
  ];
  return lines.join('\n');
}

/** CSV 转义并阻止外部文本被电子表格解析为公式。 */
function cell(value) {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"','""') + '"';
}

/** 导出整场所有档位的原始请求，统一使用毫秒计时。 */
export function csvReport(run) {
  const fields = ['id','concurrency','stageRequest','voiceId','voiceName','text','textChars','sourceRecord','sourceId','status','timedOut','phase','startedAt','synthOK','synthHttpStatus','downloadHttpStatus','synthMs','synthAttemptMs','downloadMs','downloadAttemptMs','downloadTtfbMs','downloadFailureStage','downloadFailureKind','downloadErrorCode','audioUrlOriginal','audioUrl','downloadRequestUrl','downloadFinalUrl','audioUrlNote','downloadReceivedBytes','downloadExpectedBytes','downloadContentType','downloadDiagnostics','e2eMs','queueMs','bytes','audioDurationMs','audioId','audioStorage','audioCreatedAt','audioExpiresAt','serverAudioDurationMs','serverAudioSizeBytes','subtitleMode','subtitleStorage','subtitleCount','subtitleUrl','subtitles','requestId','ttsWorker','ttsBatchId','ttsBatchSize','serverTiming','retryAfter','error','downloadAudio','downloadSkipped','intervalSilence'];
  return '\uFEFF' + [fields.join(','),...run.results.map(r=>fields.map(k=>cell(k === 'intervalSilence' ? run.config.intervalSilence : k === 'downloadAudio' ? run.config.downloadAudio !== false : k === 'concurrency' ? run.stages[r.stage].concurrency : k==='audioUrlNote'?audioUrlMissingReason(r):['downloadDiagnostics','subtitles'].includes(k)&&r[k]!=null?JSON.stringify(r[k]):r[k])).join(','))].join('\r\n');
}
