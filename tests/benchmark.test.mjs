import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp, validateConfig, inspectAudio, loadCorpus, sampleCorpus, requestBuffer, createTextSampler, createVoiceSampler } from '../server.mjs';
import { distribution, summarize, markdownReport, csvReport } from '../public/stats.js';

/** 创建最小的有效 PCM WAV，验证真实字节读取和下载计时。 */
function wav() {
  const b = Buffer.alloc(52); b.write('RIFF'); b.writeUInt32LE(44,4); b.write('WAVE',8);
  b.write('fmt ',12); b.writeUInt32LE(16,16); b.writeUInt16LE(1,20); b.writeUInt16LE(1,22);
  b.writeUInt32LE(22050,24); b.writeUInt32LE(44100,28); b.writeUInt16LE(2,32); b.writeUInt16LE(16,34);
  b.write('data',36); b.writeUInt32LE(8,40); return b;
}

/** 等待条件成立，避免把固定延迟误当作任务完成。 */
async function until(read, accept, maxMs = 8000) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) { const result = await read(); if (accept(result)) return result; await new Promise(r => setTimeout(r,15)); }
  throw new Error('等待测试结果超时');
}

/** 构造本地可控上游服务，覆盖成功、重定向、错误和慢响应。 */
async function fixture(t, corpus, settings={}) {
  const observed = { synthActive:0, synthPeak:0, calls:0, voiceCalls:0, voiceTimes:[], synthTimes:[], audioHeaders:[], bodies:[] };
  const upstream = http.createServer(async (req,res) => {
    if (req.url === '/api/v1/voices') {
      observed.voiceCalls++;assert.equal(req.headers['x-api-key'],'unit-secret');
      observed.voiceTimes.push(Date.now());
      if (settings.voiceDelay) await new Promise(resolve=>setTimeout(resolve,settings.voiceDelay));
      if (res.destroyed) return;
      res.writeHead(settings.voiceStatus||200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({voices:settings.voices||[{voice_id:'voice_test',name:'默认测试音色'}]}));return;
    }
    if (req.url === '/api/v1/tts/synthesize') {
      let body = ''; for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body); observed.bodies.push(payload); observed.calls++;
      observed.synthTimes.push(Date.now());
      assert.equal(req.headers['x-api-key'], 'unit-secret');
      assert.equal(req.headers['x-audio-delivery'], 'minio');
      assert.equal(req.headers['x-audio-purpose'], 'live_socket');
      observed.synthActive++; observed.synthPeak = Math.max(observed.synthPeak, observed.synthActive);
      let counted = false;
      /** 对正常关闭和客户端取消仅扣减一次活动请求数。 */
      const finish = () => { if (!counted) { counted = true; observed.synthActive--; } };
      res.on('close', finish);
      setTimeout(() => {
        if (res.destroyed) return;
        if (payload.text === 'FAIL_SYNTH') { res.writeHead(503,{'X-TTS-Worker':'worker-busy','Retry-After':'5'}); res.end('{"detail":"unit-secret busy"}'); finish(); return; }
        const audio = payload.text === 'FAIL_DOWNLOAD' ? '/missing.wav' : payload.text === 'BAD_AUDIO' ? '/bad.wav' : payload.text === 'SLOW_DOWNLOAD' ? '/slow.wav' : '/redirect.wav';
        res.writeHead(201, {'Content-Type':'application/json','X-Request-ID':'mock-request','X-TTS-Worker':'gpu-1','X-TTS-Batch-ID':'batch-1','X-TTS-Batch-Size':'4','Server-Timing':'queue;dur=12, inference;dur=30'});
        const origin=`http://127.0.0.1:${upstream.address().port}`;
        res.end(JSON.stringify({audio_id:'mock-audio',audio_url:payload.text==='NO_URL'?null:payload.text==='BAD_URL'?'http://[':payload.text==='RELATIVE_URL'?'/redirect.wav?relative=1':`${origin}${audio}?X-Amz-Credential=mock%2Ftest&X-Amz-Signature=a%2Bb%3D&case=1`,
          audio_storage:'minio',created_at:'2026-10-30T02:00:00Z',expires_at:null,duration_ms:4,size_bytes:52,
          subtitles:[{start:0,end:.004,text:'模拟字幕'}],subtitle_mode:'aligned',subtitle_url:`${origin}/subtitle.srt?signature=srt%2B1`,subtitle_storage:'local'})); finish();
      }, payload.text === 'SLOW' ? 1800 : 45);
      return;
    }
    observed.audioHeaders.push(req.headers);
    const pathname=new URL(req.url,'http://localhost').pathname;
    if (pathname === '/redirect.wav') { res.writeHead(302, {Location:'/audio.wav?signature=final%2B1&part=2'}); res.end(); return; }
    if (pathname === '/missing.wav') { res.writeHead(404); res.end('missing'); return; }
    if (pathname === '/bad.wav') { res.writeHead(200,{'Content-Type':'text/html'}); res.end('<html>not audio</html>'); return; }
    assert.notEqual(pathname,'/subtitle.srt','压测不应额外下载字幕');
    res.writeHead(200, {'Content-Type':'audio/wav'});
    const audio = wav(); res.write(audio.subarray(0,44)); setTimeout(() => res.end(audio.subarray(44)), pathname === '/slow.wav' ? 1800 : 35);
  });
  await new Promise(r => upstream.listen(0,'127.0.0.1',r));
  const folder = fs.mkdtempSync(path.join(os.tmpdir(),'indextts-test-'));
  const corpusPath = corpus ? path.join(folder, 'corpus-input.txt') : undefined;
  if (corpus) fs.writeFileSync(corpusPath, JSON.stringify(corpus));
  const app = createApp({ apiKey:'unit-secret', baseUrl:`http://127.0.0.1:${upstream.address().port}`, dataDir:folder, corpusPath });
  await new Promise(r => app.server.listen(0,'127.0.0.1',r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    app.shutdown(); app.server.closeAllConnections(); upstream.closeAllConnections();
    await new Promise(r => upstream.close(r));
    assert.equal(path.dirname(folder),path.resolve(os.tmpdir()));
    assert.ok(path.basename(folder).startsWith('indextts-test-'));
    fs.rmSync(folder,{recursive:true,force:true});
  });
  /** 请求本地测试服务并保留 HTTP 状态以校验校验错误。 */
  async function call(p, data) {
    const response = await fetch(base+p, data ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)} : {});
    return { status:response.status, data:await response.json() };
  }
  /** 启动测试并等待终态，默认每档三条请求。 */
  async function run(extra = {}) {
    const start = await call('/api/runs',{voiceId:'voice_test',text:'正常测试',concurrencies:'1,3',requests:3,downloadAudio:true,...extra});
    assert.equal(start.status,201);
    return until(async () => (await call('/api/runs/'+start.data.id)).data,r => !['warming','running'].includes(r.status));
  }
  return { app, observed, base, call, run, corpusPath, folder };
}

// 更换后所有新请求转向新服务，旧报告保留原地址，设置可跨重启保留。
test('页面地址设置立即切换音色和合成上游，重启及清空历史后仍保留', async t => {
  const f = await fixture(t), target = await fixture(t);
  const original = (await f.call('/api/config')).data;
  assert.equal(original.features.editableBaseUrl, true);
  const oldRun = await f.run({concurrencies:'1',requests:1});
  const targetUrl = (await target.call('/api/config')).data.baseUrl;
  const saved = await f.call('/api/config', {baseUrl:`  ${targetUrl}///  `});
  assert.equal(saved.status,200); assert.equal(saved.data.baseUrl,targetUrl);
  assert.equal((await f.call('/api/config')).data.baseUrl,targetUrl);
  assert.equal((await f.call('/api/voices')).status,200);
  const run = await f.run({concurrencies:'1',requests:1,text:'RELATIVE_URL'});
  assert.equal(run.status,'completed'); assert.equal(run.baseUrl,targetUrl);
  assert.equal(f.observed.calls,1); assert.equal(target.observed.calls,1);
  assert.equal(target.observed.voiceCalls,2);
  assert.equal((await f.call('/api/runs/'+oldRun.id)).data.baseUrl,original.baseUrl);
  const settings = JSON.parse(fs.readFileSync(path.join(f.folder,'settings.json'),'utf8'));
  assert.deepEqual(settings,{baseUrl:targetUrl});
  assert.equal((await f.call('/api/history/clear',{})).status,200);
  assert.ok(fs.existsSync(path.join(f.folder,'settings.json')));
  const restored = createApp({apiKey:'unit-secret',baseUrl:original.baseUrl,dataDir:f.folder});
  t.after(()=>restored.shutdown());
  await new Promise(resolve=>restored.server.listen(0,'127.0.0.1',resolve));
  const response = await fetch(`http://127.0.0.1:${restored.server.address().port}/api/config`);
  assert.equal((await response.json()).baseUrl,targetUrl); assert.equal(restored.runs.size,0);
});

// 非法地址及磁盘写入失败都不能改变当前生效地址。
test('页面地址设置校验协议和敏感 URL 字段，保存失败保持原配置', async t => {
  const f = await fixture(t), original = (await f.call('/api/config')).data.baseUrl;
  for (const baseUrl of ['',null,123,'localhost:8000','file:///tmp/test','https://','http://[','https://user:secret@example.com','https://example.com?x=1','https://example.com#test']) {
    assert.equal((await f.call('/api/config',{baseUrl})).status,400);
  }
  assert.equal((await f.call('/api/config')).data.baseUrl,original);
  fs.mkdirSync(path.join(f.folder,'settings.json.tmp'));
  assert.equal((await f.call('/api/config',{baseUrl:'https://example.com'})).status,400);
  assert.equal((await f.call('/api/config')).data.baseUrl,original);
  assert.ok(!fs.existsSync(path.join(f.folder,'settings.json')));
});

// 包含查询音色但尚未建立任务的时间窗口，避免同一场测试混用地址。
test('等待预约、准备及运行时禁止切换 TTS 地址', async t => {
  const f = await fixture(t,undefined,{voiceDelay:150});
  const original = (await f.call('/api/config')).data.baseUrl;
  const scheduled = await f.call('/api/runs',{text:'测试',scheduledAt:new Date(Date.now()+3600000).toISOString()});
  assert.equal((await f.call('/api/config',{baseUrl:'https://example.com'})).status,409);
  await f.call(`/api/runs/${scheduled.data.id}/stop`,{});
  const pending = f.call('/api/runs',{text:'SLOW',concurrencies:'1',requests:1});
  await until(async()=>f.observed.voiceCalls,count=>count>0);
  assert.equal((await f.call('/api/config',{baseUrl:'https://example.com'})).status,409);
  const start = await pending; assert.equal(start.status,201);
  assert.equal((await f.call('/api/config',{baseUrl:'https://example.com'})).status,409);
  assert.equal((await f.call('/api/config')).data.baseUrl,original);
  await f.call(`/api/runs/${start.data.id}/stop`,{});
});

// 预约参数仅接受带时区的未来时间，避免服务端时区造成歧义。
test('预约校验拒绝过去、无时区及非法时间，并保留绝对时间',()=>{
  const input={text:'测试'};
  for (const scheduledAt of ['yesterday','2020-01-01T00:00:00Z','2099-01-01T02:00','2099-99-99T02:00:00Z',123,true,{}]) {
    assert.throws(()=>validateConfig({...input,scheduledAt}),/预约时间/);
  }
  const date=new Date(Date.now()+3600000).toISOString();
  assert.equal(validateConfig({...input,scheduledAt:date}).scheduledAt,Date.parse(date));
  assert.equal(validateConfig({...input,scheduledAt:'2099-01-01T02:00:00+08:00'}).scheduledAt,Date.parse('2098-12-31T18:00:00Z'));
  assert.equal(validateConfig({...input,scheduledAt:''}).scheduledAt,undefined);
});

// 到点后才查询音色和预热，等待预约不计入测试时间。
test('一次性预约到点启动，预热和各档完整执行且阻止重复开测和清空',async t=>{
  const f=await fixture(t);const scheduledAt=Date.now()+600;
  const start=await f.call('/api/runs',{text:'正常测试',concurrencies:'1,2',requests:2,warmup:1,scheduledAt:new Date(scheduledAt).toISOString()});
  assert.equal(start.status,201);
  const waiting=(await f.call('/api/runs/'+start.data.id+'?compact=1')).data;
  assert.equal(waiting.status,'scheduled');assert.equal(waiting.startedAt,null);
  assert.equal(f.observed.calls,0);assert.equal(f.observed.voiceCalls,0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.folder,start.data.id+'.json'),'utf8')).status,'scheduled');
  assert.equal((await f.call('/api/config')).data.features.scheduledStart,true);
  assert.equal((await f.call('/api/runs',{text:'不能重复开始'})).status,409);
  assert.equal((await f.call('/api/history/clear',{})).status,409);
  const run=await until(async()=>(await f.call('/api/runs/'+start.data.id)).data,r=>r.reportsReady);
  assert.equal(run.status,'completed');assert.equal(run.config.scheduledAt,scheduledAt);
  assert.ok(run.startedAt>=scheduledAt);assert.ok(run.startedAt>run.createdAt);
  assert.equal(f.observed.voiceCalls,1);assert.equal(f.observed.calls,5);
  assert.ok(f.observed.voiceTimes.every(time=>time>=scheduledAt));
  assert.ok(f.observed.synthTimes.every(time=>time>=scheduledAt));
  assert.ok(run.stages.every(stage=>stage.state==='completed'));
  assert.match(markdownReport(run),/预约启动时间/);assert.match(markdownReport(run),/实际开始时间（含预热）/);
});

// 超过 setTimeout 上限的预约也不能提前触发，取消必须释放唯一任务槽位。
test('远期预约不会立即触发，取消幂等且不发起请求，随后能立即开测',async t=>{
  const f=await fixture(t);
  const start=await f.call('/api/runs',{text:'正常测试',concurrencies:'1',requests:1,scheduledAt:new Date(Date.now()+40*86400000).toISOString()});
  assert.equal(start.status,201);
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(f.observed.calls,0);assert.equal(f.observed.voiceCalls,0);
  await f.call(`/api/runs/${start.data.id}/stop`,{});
  const run=(await f.call('/api/runs/'+start.data.id)).data;
  assert.equal(run.status,'cancelled');assert.equal(run.startedAt,null);assert.equal(run.stopReason,'用户取消预约');
  assert.ok(run.reportsReady);assert.equal(run.stages[0].state,'skipped');
  assert.ok(run.results.every(row=>row.status==='cancelled'&&!row.startedAt));
  await f.call(`/api/runs/${start.data.id}/stop`,{});
  assert.equal((await f.call('/api/runs/'+start.data.id)).data.stopRequestedAt,run.stopRequestedAt);
  assert.match(markdownReport(run),/尚未开始/);
  const next=await f.run({concurrencies:'1',requests:1});assert.equal(next.status,'completed');
  assert.equal(f.observed.calls,1);
});

// 查询失败保留失败报告，查询过程中取消也不能漏出合成请求。
test('预约启动时音色失败和准备中取消均不发压且生成报告',async t=>{
  const broken=await fixture(t,undefined,{voiceStatus:503});
  const failed=await broken.call('/api/runs',{text:'测试',concurrencies:'1',requests:1,scheduledAt:new Date(Date.now()+80).toISOString()});
  const run=await until(async()=>(await broken.call('/api/runs/'+failed.data.id)).data,r=>r.reportsReady);
  assert.equal(run.status,'failed');assert.equal(broken.observed.calls,0);assert.equal(run.startedAt,null);
  const slow=await fixture(t,undefined,{voiceDelay:500});
  const start=await slow.call('/api/runs',{text:'测试',scheduledAt:new Date(Date.now()+80).toISOString()});
  await until(async()=>(await slow.call('/api/runs/'+start.data.id)).data,r=>r.status==='preparing');
  await slow.call(`/api/runs/${start.data.id}/stop`,{});
  const stopped=await until(async()=>(await slow.call('/api/runs/'+start.data.id)).data,r=>r.reportsReady);
  assert.equal(stopped.status,'cancelled');assert.equal(stopped.startedAt,null);assert.equal(slow.observed.calls,0);
});

// 模拟休眠后发现时间已过，避免在错误时段补跑压测。
test('错过预约一分钟后记为失败，不补跑合成并释放任务槽位',async t=>{
  const f=await fixture(t);
  const start=await f.call('/api/runs',{text:'测试',scheduledAt:new Date(Date.now()+100).toISOString()});
  f.app.runs.get(start.data.id).config.scheduledAt=Date.now()-61000;
  const run=await until(async()=>(await f.call('/api/runs/'+start.data.id)).data,r=>r.reportsReady);
  assert.equal(run.status,'failed');assert.match(run.error,/错过预约/);
  assert.equal(f.observed.calls,0);assert.equal(f.observed.voiceCalls,0);
  assert.equal((await f.call('/api/history/clear',{})).status,200);
});

// 重启不恢复发压，也不改写可能属于其他仍在运行服务的磁盘快照。
test('服务重启把未执行预约标为中断，重复重启也不会补跑',async t=>{
  const f=await fixture(t);
  const start=await f.call('/api/runs',{text:'测试',scheduledAt:new Date(Date.now()+300).toISOString()});
  f.app.shutdown();
  const restored=createApp({apiKey:'unit-secret',baseUrl:'http://127.0.0.1:1',dataDir:f.folder});
  t.after(()=>restored.shutdown());
  const run=restored.runs.get(start.data.id);
  assert.equal(run.status,'interrupted');assert.match(run.error,/不会补跑/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.folder,run.id+'.json'),'utf8')).status,'scheduled');
  await new Promise(resolve=>setTimeout(resolve,400));assert.equal(f.observed.calls,0);assert.equal(f.observed.voiceCalls,0);
  const again=createApp({apiKey:'unit-secret',baseUrl:'http://127.0.0.1:1',dataDir:f.folder});
  t.after(()=>again.shutdown());assert.equal(again.runs.get(run.id).status,'interrupted');
});

test('统计使用最近秩、独立阶段样本和真实吞吐分母', () => {
  assert.equal(distribution([]).p95,null); assert.equal(distribution([1,2,3,4,5]).p95,5);
  assert.equal(distribution([100,200]).p50,100);
  const run = {stages:[{index:0,concurrency:1,startedAt:1000,endedAt:3000}],results:[
    {stage:0,status:'success',startedAt:1000,synthOK:true,synthMs:100,downloadMs:20,e2eMs:120,bytes:10},
    {stage:0,status:'failed',startedAt:2000,synthOK:true,synthMs:300,downloadAttemptMs:40}]};
  const s = summarize(run)[0]; assert.equal(s.synth.mean,200); assert.equal(s.download.mean,20);
  assert.equal(s.rps,.5); assert.equal(s.failed,1); assert.equal(s.successRate,.5);
});

test('随机音色序列可复现，每一轮覆盖全部音色，预热独立抽取',()=>{
  const config={voiceMode:'random',voiceSamplingSeed:123,voicePool:['a','b','c'].map(voiceId=>({voiceId,voiceName:voiceId}))};
  const a=createVoiceSampler(config),b=createVoiceSampler(config);
  const sequence=Array.from({length:12},(_,i)=>a(i).voiceId);
  assert.deepEqual(sequence,Array.from({length:12},(_,i)=>b(i).voiceId));
  for(let i=0;i<12;i+=3)assert.equal(new Set(sequence.slice(i,i+3)).size,3);
  const warmup=Array.from({length:3},(_,i)=>a(i,true).voiceId);
  assert.equal(new Set(warmup).size,3);
  assert.throws(()=>createVoiceSampler({...config,voicePool:[]})(0),/没有可用音色/);
});

test('并发请求使用随机音色池，报告、CSV 和实际发送音色一致',async t=>{
  const voices=['a','b','c'].map(id=>({voice_id:'voice_'+id,name:'音色'+id}));
  const f=await fixture(t,undefined,{voices:[...voices,voices[0],{voice_id:'hidden',api_visible:false},{voice_id:'bad/id'}]});
  const run=await f.run({requests:6,warmup:2,voiceSamplingSeed:123});
  assert.equal(run.config.voiceMode,'random');assert.equal(run.config.voicePool.length,3);
  assert.equal(f.observed.voiceCalls,1);assert.equal(f.observed.calls,14);
  for(const stage of run.stages) {
    const rows=run.results.filter(r=>r.stage===stage.index);
    for(let i=0;i<6;i+=3)assert.equal(new Set(rows.slice(i,i+3).map(r=>r.voiceId)).size,3);
  }
  assert.deepEqual(run.results.slice(0,6).map(r=>r.voiceId),run.results.slice(6).map(r=>r.voiceId));
  assert.deepEqual(f.observed.bodies.slice(2).map(b=>b.voice_id),run.results.map(r=>r.voiceId));
  assert.ok(run.results.every(r=>voices.some(v=>v.voice_id===r.voiceId&&v.name===r.voiceName)));
  const report=markdownReport(run);assert.match(report,/音色分配/);assert.match(report,/随机种子 123/);
  assert.match(csvReport(run),/stageRequest,voiceId,voiceName/);
  for(const voice of voices){assert.ok(report.includes(voice.voice_id));assert.ok(report.includes(voice.name));}
});

test('音色池为空或查询失败时拒绝开测，不回退为固定音色',async t=>{
  const empty=await fixture(t,undefined,{voices:[]});
  const failed=await empty.call('/api/runs',{text:'测试'});
  assert.equal(failed.status,502);assert.match(failed.data.error,/没有可用音色/);assert.equal(empty.observed.calls,0);
  assert.deepEqual((await empty.call('/api/runs')).data,[]);
  const broken=await fixture(t,undefined,{voiceStatus:503});
  const unavailable=await broken.call('/api/runs',{text:'测试'});
  assert.equal(unavailable.status,502);assert.equal(broken.observed.calls,0);
  const fixed=await broken.run({voiceMode:'fixed',concurrencies:'1',requests:1});assert.equal(fixed.status,'completed');
});

test('清空历史会归档全部报告和音频，保护无关文件并让导出失效',async t=>{
  const f=await fixture(t);const run=await f.run({concurrencies:'1',requests:1});
  const untouched=path.join(f.folder,'keep.txt');fs.writeFileSync(untouched,'保留');
  const original=fs.readFileSync(path.join(f.folder,run.id+'.json'),'utf8');
  const unloaded='2026-01-01T00-00-00-000Z-1234abcd';
  fs.writeFileSync(path.join(f.folder,unloaded+'.json'),JSON.stringify({...run,id:unloaded}));
  const cleared=await f.call('/api/history/clear',{});
  assert.equal(cleared.status,200);assert.equal(cleared.data.cleared,2);
  assert.ok(cleared.data.archivePath.startsWith(path.join(f.folder,'.history-trash')+path.sep));
  assert.equal(fs.readFileSync(path.join(cleared.data.archivePath,run.id+'.json'),'utf8'),original);
  assert.equal(fs.statSync(path.join(cleared.data.archivePath,run.id,'1.wav')).size,52);
  for(const ext of ['.md','.csv','.download-failures.csv'])assert.ok(fs.existsSync(path.join(cleared.data.archivePath,run.id+ext)));
  assert.ok(fs.existsSync(path.join(cleared.data.archivePath,unloaded+'.json')));
  assert.equal(fs.readFileSync(untouched,'utf8'),'保留');assert.deepEqual((await f.call('/api/runs')).data,[]);
  assert.equal((await f.call('/api/runs/'+run.id)).status,404);
  const report=await fetch(f.base+`/api/runs/${run.id}/report.md`);assert.equal(report.status,404);
  const again=await f.call('/api/history/clear',{});assert.equal(again.data.cleared,0);assert.equal(again.data.archivePath,null);
});

test('运行中及其他服务留下的活动记录阻止清空历史',async t=>{
  const f=await fixture(t);
  const start=await f.call('/api/runs',{text:'SLOW',concurrencies:'1',requests:1});
  await until(async()=>f.observed.calls,n=>n===1);
  assert.equal((await f.call('/api/history/clear',{})).status,409);
  assert.ok(fs.existsSync(path.join(f.folder,start.data.id+'.json')));
  await f.call(`/api/runs/${start.data.id}/stop`,{});
  await until(async()=>(await f.call('/api/runs/'+start.data.id)).data,r=>r.status==='cancelled');
  const foreign='2026-01-01T00-00-00-000Z-abcd1234';
  fs.writeFileSync(path.join(f.folder,foreign+'.json'),JSON.stringify({status:'running'}));
  const blocked=await f.call('/api/history/clear',{});assert.equal(blocked.status,409);assert.match(blocked.data.error,/磁盘中仍有运行中/);
  assert.ok(fs.existsSync(path.join(f.folder,start.data.id+'.json')));
});

test('大于 64 并发实际进入上游，客户端连接池不截流且可手动停止',async t=>{
  const f=await fixture(t);
  const started=await f.call('/api/runs',{text:'SLOW',concurrencies:'80',stageSeconds:60});
  assert.equal(started.status,201);
  await until(async()=>f.observed.synthPeak,n=>n===80,5000);
  await f.call(`/api/runs/${started.data.id}/stop`,{});
  const run=await until(async()=>(await f.call('/api/runs/'+started.data.id)).data,r=>r.status==='cancelled');
  assert.equal(run.stages[0].peakActive,80);assert.equal(f.observed.synthPeak,80);
  assert.equal(run.reportsReady,true);assert.ok(run.results.every(r=>r.status==='cancelled'));
});

test('配置校验与 WAV 内容检查', () => {
  const defaults = validateConfig({voiceId:'v',text:'测试'});
  assert.equal(defaults.downloadAudio,false);
  assert.equal(validateConfig({text:'测试',downloadAudio:true}).downloadAudio,true);
  for (const downloadAudio of ['false','true',0,1,null]) assert.throws(()=>validateConfig({text:'测试',downloadAudio}),/downloadAudio/);
  assert.equal(defaults.synthTimeout,20); assert.equal(defaults.downloadTimeout,10);
  assert.equal(defaults.mode,'duration'); assert.equal(defaults.stageSeconds,600);
  assert.deepEqual(defaults.concurrencies,[4,8,16,24,32]);
  assert.throws(() => validateConfig({voiceId:'v',text:'测试',synthTimeout:21}),/synthTimeout/);
  assert.throws(() => validateConfig({voiceId:'v',text:'测试',downloadTimeout:11}),/downloadTimeout/);
  assert.throws(() => validateConfig({voiceId:'v',text:'测试',concurrencies:'4',requests:2}),/不少于/);
  assert.deepEqual(validateConfig({text:'测试',concurrencies:'33,64,128,1000'}).concurrencies,[33,64,128,1000]);
  for(const concurrencies of ['0','-1','1.5','Infinity','9007199254740992'])assert.throws(()=>validateConfig({text:'测试',concurrencies}),/正整数/);
  assert.throws(() => validateConfig({voiceId:'v',text:'x'.repeat(5001)}),/5000/);
  assert.throws(() => inspectAudio(Buffer.from('<html>error</html>')),/WAV/);
  assert.ok(inspectAudio(wav()) > 0);
});

test('持续压测依次完成五档并保持补位，到时收尾不交叠，整场自动生成统一报告', async t => {
  const f = await fixture(t);
  const run = await f.run({mode:'duration',concurrencies:'4,8,16,24,32',stageSeconds:1});
  assert.equal(run.status,'completed'); assert.equal(run.config.requests,null);
  assert.ok(run.results.length > 84); assert.equal(run.stages.length,5);
  for (let i=0; i<run.stages.length; i++) {
    const s=run.stages[i], rows=run.results.filter(r=>r.stage===i);
    assert.equal(s.peakActive,s.concurrency); assert.equal(s.state,'completed');
    assert.ok(rows.length > s.concurrency); assert.ok(s.endedAt >= s.deadlineAt);
    assert.ok(rows.every(r=>r.startedAt <= s.deadlineAt+10));
    assert.ok(rows.every(r=>r.endedAt <= s.endedAt));
    if (i) assert.ok(s.startedAt>=run.stages[i-1].endedAt);
    assert.ok(rows.filter(r=>r.localAudio).length<=3);
  }
  assert.equal(run.reportsReady,true); assert.equal(run.overall.attempted,run.results.length);
  assert.ok(fs.readFileSync(path.join(f.folder,run.id+'.md'),'utf8').includes('持续并发压测汇总报告'));
  assert.ok(fs.statSync(path.join(f.folder,run.id+'.csv')).size>1000);
  const compact=(await f.call(`/api/runs/${run.id}?compact=1`)).data;
  assert.ok(compact.results.length<=200); assert.equal(compact.overall.total,run.results.length);
  assert.equal(compact.summary.reduce((n,s)=>n+s.attempted,0),run.results.length);
  assert.equal(compact.detailOffset,Math.max(0,run.results.length-200));
});

test('持续抽样用尽语料后重新洗牌，档位从相同起点取词且不受语料条数限制', () => {
  const corpus={sourceFile:'samples.csv',column:'合成文字',entries:Array.from({length:4},(_,i)=>({text:'测试'+i,sourceId:'id'+i,sourceRecord:i+1}))};
  const config=validateConfig({mode:'duration',voiceId:'v',textSource:'csv',stageSeconds:1,samplingSeed:123},corpus);
  const sampler=createTextSampler(config,corpus);
  const a=Array.from({length:20},(_,i)=>sampler(i).text);
  const b=Array.from({length:20},(_,i)=>sampler(i).text);
  assert.deepEqual(a,b);
  for (let i=0;i<20;i+=4) assert.equal(new Set(a.slice(i,i+4)).size,4);
  assert.throws(()=>validateConfig({voiceId:'v',text:'test',mode:'duration',stageSeconds:0}),/持续时间/);
});

test('持续模式停止立即取消在途请求，后续档位不启动并保留汇总报告', async t => {
  const f=await fixture(t);
  const start=await f.call('/api/runs',{voiceId:'voice_test',text:'SLOW',mode:'duration',concurrencies:'4,8',stageSeconds:60});
  await until(async()=>f.observed.calls,n=>n===4);
  await f.call(`/api/runs/${start.data.id}/stop`,{});
  const run=await until(async()=>(await f.call('/api/runs/'+start.data.id)).data,r=>r.status==='cancelled');
  assert.equal(f.observed.calls,4); assert.equal(run.stages[1].startedAt,undefined);
  assert.equal(run.summary[0].cancelled,4); assert.equal(run.reportsReady,true);
  assert.equal(run.summary[1].state,'skipped'); assert.ok(run.stopRequestedAt);
  const saved=fs.readFileSync(path.join(f.folder,run.id+'.md'),'utf8');
  assert.match(saved,/用户手动停止/); assert.match(saved,/部分结果/);
  for (const format of ['md','csv','json']) assert.ok(fs.statSync(path.join(f.folder,run.id+'.'+format)).size>0);
});

test('单档可设置按小时运行，停止后保留成功样本、取消在途请求并可导出部分报告', async t => {
  const f=await fixture(t);
  const config=validateConfig({mode:'duration',runMode:'single',voiceId:'voice_test',concurrencies:'8',hours:2,text:'正常测试'});
  assert.equal(config.stageSeconds,7200); assert.deepEqual(config.concurrencies,[8]);
  assert.equal(config.runMode,'single');
  assert.throws(()=>validateConfig({voiceId:'v',text:'测试',mode:'duration',runMode:'single',concurrencies:'4,8',hours:2}),/只能/);
  const start=await f.call('/api/runs',{voiceId:'voice_test',text:'正常测试\nSLOW',mode:'duration',runMode:'single',concurrencies:'1',hours:2});
  assert.equal(start.status,201);
  await until(async()=>f.observed.calls,n=>n>=2);
  await f.call(`/api/runs/${start.data.id}/stop`,{});
  const run=await until(async()=>(await f.call('/api/runs/'+start.data.id)).data,r=>r.status==='cancelled');
  assert.equal(run.stages.length,1); assert.equal(run.summary[0].success,1);
  assert.equal(run.summary[0].cancelled,1); assert.equal(run.summary[0].failed,0);
  assert.equal(run.reportsReady,true); assert.equal(f.observed.calls,2);
  const stopTime=run.stopRequestedAt;
  await f.call(`/api/runs/${start.data.id}/stop`,{});
  const again=(await f.call('/api/runs/'+start.data.id)).data;
  assert.equal(again.stopRequestedAt,stopTime);
  const md=await (await fetch(f.base+`/api/runs/${start.data.id}/report.md`)).text();
  assert.match(md,/单档持续并发测试报告/); assert.match(md,/持续 2 小时/);
  assert.match(md,/用户手动停止/); assert.match(md,/报告范围：部分结果/);
  const successUrls=md.split('## 全部请求音频 URL')[1].split('## 字幕与存储交付')[0];
  assert.match(successUrls,/合成结束前取消，未获取音频 URL/);
  assert.ok(successUrls.includes(`<${run.results.find(r=>r.status==='success').audioUrl}>`));
  const csv=await (await fetch(f.base+`/api/runs/${start.data.id}/report.csv`)).text();
  assert.match(csv,/success/); assert.match(csv,/cancelled/);
});

test('预热时手动停止也生成报告，不把用户取消描述为预热失败', async t => {
  const f=await fixture(t);
  const start=await f.call('/api/runs',{voiceId:'voice_test',text:'SLOW',mode:'duration',runMode:'single',concurrencies:'1',hours:1,warmup:1});
  await until(async()=>f.observed.calls,n=>n===1);
  await f.call(`/api/runs/${start.data.id}/stop`,{});
  const run=await until(async()=>(await f.call('/api/runs/'+start.data.id)).data,r=>r.status==='cancelled');
  assert.equal(run.results.length,0); assert.equal(run.warmupError,undefined);
  assert.equal(run.reportsReady,true); assert.equal(run.stages[0].state,'skipped');
  assert.match(fs.readFileSync(path.join(f.folder,run.id+'.md'),'utf8'),/用户手动停止/);
});

/** 验证默认模式不访问音频存储，预热、统计及持久化都采用获取链接的口径。 */
test('默认跳过预热和正式下载，获取链接即成功，保存空下载指标和报告', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/config')).data.features.optionalAudioDownload,true);
  const start = await f.call('/api/runs',{text:'FAIL_DOWNLOAD\nBAD_AUDIO\nSLOW_DOWNLOAD\nRELATIVE_URL',concurrencies:'1,2',requests:4,warmup:1});
  assert.equal(start.status,201);
  const run = await until(async () => (await f.call('/api/runs/'+start.data.id)).data, r => r.reportsReady);
  assert.equal(run.status,'completed'); assert.equal(run.config.downloadAudio,false);
  assert.equal(run.warmupDone,1); assert.equal(f.observed.calls,9);
  assert.equal(f.observed.audioHeaders.length,0); assert.equal(run.overall.success,8);
  assert.equal(run.overall.download.count,0); assert.equal(run.downloadFailureAnalysis.total,0);
  assert.ok(run.results.every(r => r.status==='success' && r.synthOK && r.downloadSkipped && r.endedAt && r.e2eMs >= r.synthMs));
  assert.ok(run.results.every(r => !r.localAudio && r.downloadMs == null && r.downloadAttemptMs == null && r.downloadTtfbMs == null && r.bytes == null && !r.downloadRequestUrl && !r.downloadFinalUrl));
  assert.ok(run.results.every(r => r.audioUrl.startsWith('http://') && r.audioUrlOriginal && r.audioStorage==='minio'));
  assert.ok(!fs.existsSync(path.join(f.folder,run.id)));
  assert.equal((await fetch(f.base+`/api/runs/${run.id}/audio/1`)).status,404);
  const md = fs.readFileSync(path.join(f.folder,run.id+'.md'),'utf8');
  assert.match(md,/关闭（拿到音频链接即成功）/); assert.match(md,/获取链接成功率：100.00%/);
  assert.match(md,/全流程耗时：单条请求开始合成至获取音频链接/);
  assert.doesNotMatch(md,/所有请求均完整下载|音频读取并校验完成/);
  for (const row of run.results) assert.ok(md.includes(row.audioUrlOriginal));
  const saved = JSON.parse(fs.readFileSync(path.join(f.folder,run.id+'.json'),'utf8'));
  assert.equal(saved.config.downloadAudio,false); assert.equal(saved.results[0].downloadSkipped,true);
  const csv = fs.readFileSync(path.join(f.folder,run.id+'.csv'),'utf8');
  assert.match(csv,/downloadAudio,downloadSkipped/);
  const headers = csv.replace(/^\uFEFF/,'').split('\r\n')[0].split(',');
  const values = csv.split('\r\n')[1].match(/"(?:[^"]|"")*"/g);
  assert.equal(values[headers.indexOf('downloadAudio')],'"false"');
  assert.equal(values[headers.indexOf('downloadMs')],'""');
  assert.ok(run.summary.every(s => s.download.count===0 && s.ttfb.count===0));
});

/** 跳过下载只改变成功终点，合成和链接校验失败仍应计为失败。 */
test('跳过下载仍拒绝合成失败、缺失或异常音频链接，且不产生下载失败', async t => {
  const f = await fixture(t);
  const run = await f.run({downloadAudio:false,concurrencies:'1',requests:4,text:'FAIL_SYNTH\nNO_URL\nBAD_URL\n正常测试'});
  assert.deepEqual(run.results.map(r => r.status),['failed','failed','failed','success']);
  assert.equal(f.observed.calls,4); assert.equal(f.observed.audioHeaders.length,0);
  assert.match(run.results[1].error,/audio_url/);
  assert.equal(run.downloadFailureAnalysis.total,0);
});

test('真实工作池遵守并发阶梯，下载完整内容且不传密钥，报告和录音可读取', async t => {
  const f = await fixture(t); const run = await f.run();
  assert.equal(run.status,'completed'); assert.equal(run.results.filter(r=>r.status==='success').length,6);
  assert.equal(f.observed.synthPeak,3); assert.equal(run.stages[0].peakActive,1); assert.equal(run.stages[1].peakActive,3);
  assert.ok(run.stages[1].startedAt >= run.stages[0].endedAt);
  assert.ok(run.results.every(r=>r.downloadMs >= 25 && r.e2eMs >= r.synthMs + r.downloadMs));
  assert.ok(f.observed.audioHeaders.length >= 12); assert.ok(f.observed.audioHeaders.every(h=>!h['x-api-key'] && !h.authorization));
  assert.ok(f.observed.audioHeaders.every(h=>!h['x-audio-delivery'] && !h['x-audio-purpose']));
  assert.equal(run.config.audioDelivery,'minio');assert.equal(run.config.audioPurpose,'live_socket');
  assert.ok(f.observed.bodies.every(b => !('model' in b) && b.voice_id === 'voice_test'));
  assert.ok(!JSON.stringify(run).includes('unit-secret')); assert.match(markdownReport(run),/不能分离纯模型推理时间/);
  assert.match(csvReport(run),/downloadTtfbMs/);
  const savedReport=fs.readFileSync(path.join(f.folder,run.id+'.md'),'utf8');
  assert.match(savedReport,/请求音频交付：minio；用途：live_socket/);
  const successUrls=savedReport.split('## 全部请求音频 URL')[1].split('## 字幕与存储交付')[0];
  for (const row of run.results) {
    assert.ok(successUrls.includes(`| ${row.id} | ${run.stages[row.stage].concurrency} | 成功 | <${row.audioUrlOriginal}> | <${row.downloadRequestUrl}> | <${row.downloadFinalUrl}> |`));
  }
  const audio = await fetch(f.base+`/api/runs/${run.id}/audio/1`); assert.equal((await audio.arrayBuffer()).byteLength,52);
  for (const format of ['md','csv','json']) { const report = await fetch(f.base+`/api/runs/${run.id}/report.${format}`); assert.equal(report.status,200); assert.ok((await report.text()).length > 100); }
});

test('失败不重试，下载失败保留合成成功样本，拒绝伪造音频', async t => {
  const f = await fixture(t);
  const run = await f.run({concurrencies:'2',requests:3,text:'FAIL_SYNTH\nFAIL_DOWNLOAD\nBAD_AUDIO'});
  assert.equal(f.observed.calls,3); assert.equal(run.summary[0].failed,3); assert.equal(run.summary[0].synth.count,2);
  assert.equal(run.summary[0].download.count,0); assert.ok(!JSON.stringify(run).includes('unit-secret'));
  assert.equal(run.results[0].httpStatus,503); assert.equal(run.results[1].httpStatus,404);
  assert.match(run.results[2].error,/WAV/);
  assert.equal(run.results[1].downloadFailureStage,'http_status');
  assert.equal(run.results[1].downloadErrorCode,'HTTP_404');
  assert.equal(run.results[2].downloadFailureStage,'validation');
  assert.equal(run.downloadFailureAnalysis.total,2);
  assert.match(markdownReport(run),/下载失败专项分析/);assert.match(markdownReport(run),/missing.wav/);
  assert.match(csvReport(run),/downloadFailureStage/);
  const failuresCsv=await (await fetch(f.base+`/api/runs/${run.id}/download-failures.csv`)).text();
  assert.match(failuresCsv,/FAIL_DOWNLOAD/);assert.match(failuresCsv,/BAD_AUDIO/);assert.doesNotMatch(failuresCsv,/FAIL_SYNTH/);
  assert.ok(fs.existsSync(path.join(f.folder,run.id+'.download-failures.csv')));
  assert.equal(run.results[0].ttsWorker,'worker-busy');assert.equal(run.results[0].retryAfter,'5');
});

test('新文档元数据及完整签名 URL 在成功、下载失败和无 URL 请求中均可追溯',async t=>{
  const f=await fixture(t);
  const run=await f.run({concurrencies:'1',requests:6,text:'正常测试\nFAIL_DOWNLOAD\nSLOW_DOWNLOAD\nNO_URL\nBAD_URL\nRELATIVE_URL',downloadTimeout:1});
  const [ok,missing,timeout,noUrl,badUrl,relative]=run.results;
  assert.equal(ok.status,'success');assert.equal(missing.status,'failed');assert.equal(timeout.timedOut,true);
  for(const row of [ok,missing,timeout]) {
    assert.ok(row.audioUrlOriginal.endsWith('?X-Amz-Credential=mock%2Ftest&X-Amz-Signature=a%2Bb%3D&case=1'));
    assert.equal(row.audioUrl,row.audioUrlOriginal);assert.equal(row.downloadRequestUrl,row.audioUrl);
    assert.equal(row.audioStorage,'minio');assert.equal(row.subtitleMode,'aligned');assert.equal(row.subtitleCount,1);
    assert.equal(row.subtitleStorage,'local');assert.equal(row.audioExpiresAt,null);
    assert.deepEqual(row.subtitles,[{start:0,end:.004,text:'模拟字幕'}]);
    assert.equal(row.serverAudioDurationMs,4);assert.equal(row.serverAudioSizeBytes,52);
    assert.equal(row.ttsWorker,'gpu-1');assert.equal(row.ttsBatchId,'batch-1');assert.equal(row.ttsBatchSize,'4');
    assert.equal(row.serverTiming,'queue;dur=12, inference;dur=30');
  }
  assert.ok(ok.downloadFinalUrl.endsWith('/audio.wav?signature=final%2B1&part=2'));
  assert.equal(noUrl.synthOK,false);assert.equal(noUrl.audioUrlOriginal,null);
  assert.equal(badUrl.audioUrlOriginal,'http://[');assert.equal(badUrl.downloadRequestUrl,undefined);
  assert.equal(relative.audioUrlOriginal,'/redirect.wav?relative=1');assert.equal(relative.status,'success');
  assert.ok(relative.downloadRequestUrl.endsWith('/redirect.wav?relative=1'));assert.notEqual(relative.downloadRequestUrl,relative.audioUrlOriginal);
  const report=await(await fetch(f.base+`/api/runs/${run.id}/report.md`)).text();
  const urlChapter=report.split('## 全部请求音频 URL')[1].split('## 字幕与存储交付')[0];
  for(const row of [ok,missing,timeout])assert.ok(urlChapter.includes(`<${row.audioUrlOriginal}>`));
  assert.match(urlChapter,/合成响应未返回有效音频 URL/);assert.match(report,/gpu-1/);assert.match(report,/subtitle.srt\?signature=srt%2B1/);
  const exported=await(await fetch(f.base+`/api/runs/${run.id}/report.json`)).json();
  assert.equal(exported.results[2].audioUrlOriginal,timeout.audioUrlOriginal);
  const csv=await(await fetch(f.base+`/api/runs/${run.id}/report.csv`)).text();
  assert.match(csv,/audioUrlOriginal,audioUrl,downloadRequestUrl,downloadFinalUrl,audioUrlNote/);
  assert.ok(csv.includes(timeout.audioUrlOriginal));assert.ok(csv.includes('"aligned"'));assert.ok(csv.includes('"gpu-1"'));
  assert.equal(f.observed.calls,6);
});

test('超时覆盖等待响应，不自动重试；预热失败阻止正式请求', async t => {
  const f = await fixture(t);
  const timeout = await f.run({concurrencies:'1',requests:1,text:'SLOW',synthTimeout:1});
  assert.equal(timeout.results[0].status,'failed'); assert.match(timeout.results[0].error,/超时/); assert.equal(f.observed.calls,1);
  assert.equal(timeout.results[0].timedOut,true); assert.ok(timeout.results[0].e2eMs < 1600);
  const warmup = await f.run({concurrencies:'1',requests:1,text:'FAIL_SYNTH',warmup:1});
  assert.equal(warmup.status,'failed'); assert.equal(warmup.summary[0].attempted,0); assert.ok(warmup.warmupError); assert.equal(f.observed.calls,2);
});

test('下载已经收到部分音频也必须按总截止时间中止，并继续后续任务', async t => {
  const f = await fixture(t);
  const run = await f.run({concurrencies:'1',requests:2,text:'SLOW_DOWNLOAD\n正常测试',downloadTimeout:1});
  assert.equal(run.results[0].status,'failed'); assert.equal(run.results[0].synthOK,true);
  assert.equal(run.results[0].timedOut,true); assert.match(run.results[0].error,/下载超时/);
  assert.ok(run.results[0].downloadAttemptMs >= 900 && run.results[0].downloadAttemptMs < 1600);
  assert.equal(run.results[0].downloadFailureStage,'body_read');
  assert.equal(run.results[0].downloadReceivedBytes,44);assert.equal(run.results[0].downloadHttpStatus,200);
  assert.equal(run.downloadFailureAnalysis.timeouts,1);
  assert.equal(run.results[1].status,'success'); assert.equal(run.summary[0].failed,1);
  assert.equal(run.summary[0].success,1);
});

test('手动取消下载有独立诊断，但不混入下载失败或超时专项统计',async t=>{
  const f=await fixture(t);
  const start=await f.call('/api/runs',{voiceId:'voice_test',text:'SLOW_DOWNLOAD',concurrencies:'1',requests:1,downloadAudio:true});
  await until(async()=>f.observed.audioHeaders.length,n=>n>0);
  await f.call(`/api/runs/${start.data.id}/stop`,{});
  const run=await until(async()=>(await f.call('/api/runs/'+start.data.id)).data,r=>r.status==='cancelled');
  assert.equal(run.results[0].downloadFailureKind,'cancelled');
  assert.ok(run.results[0].downloadDiagnostics.currentUrl);
  assert.equal(run.downloadFailureAnalysis.total,0);assert.equal(run.downloadFailureAnalysis.timeouts,0);
  assert.equal(run.downloadFailureAnalysis.cancelled,1);
  const report=markdownReport(run).split('## 全部请求音频 URL')[1].split('## 字幕与存储交付')[0];
  assert.ok(report.includes(`<${run.results[0].audioUrlOriginal}>`));
  assert.match(report,/取消/);
});

test('重定向链共用一个下载总截止时间，不能逐跳延长等待', async t => {
  const upstream = http.createServer((req,res) => {
    setTimeout(() => {
      if (res.destroyed) return;
      if (req.url === '/first') { res.writeHead(302,{Location:'/second'}); res.end(); }
      else { res.writeHead(200); res.end(wav()); }
    },650);
  });
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const started = Date.now();
  await assert.rejects(requestBuffer(`http://127.0.0.1:${upstream.address().port}/first`,{timeoutMs:1000}),/超时/);
  assert.ok(Date.now()-started < 1600);
});

test('停止取消在途连接和队列，并拒绝第二个活动任务', async t => {
  const f = await fixture(t); const input = {voiceId:'voice_test',text:'SLOW',concurrencies:'2',requests:10};
  const first = await f.call('/api/runs',input); const id = first.data.id;
  await until(async () => f.observed.calls,n=>n===2);
  const conflict = await f.call('/api/runs',input); assert.equal(conflict.status,409);
  await f.call(`/api/runs/${id}/stop`,{});
  const run = await until(async ()=>(await f.call('/api/runs/'+id)).data,r=>r.status==='cancelled');
  assert.equal(f.observed.calls,2); assert.equal(run.results.filter(r=>r.status==='cancelled').length,10);
  assert.equal(run.summary[0].failed,0); assert.equal(run.summary[0].attempted,2);
});

test('本地服务拒绝跨站操作，静态页面和配置不暴露密钥', async t => {
  const f = await fixture(t);
  const blocked = await fetch(f.base+'/api/runs',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:'{}'});
  assert.equal(blocked.status,403);
  const config = await f.call('/api/config'); assert.equal(config.data.hasKey,true); assert.ok(!JSON.stringify(config).includes('unit-secret'));
  const page = await fetch(f.base+'/'); assert.equal(page.status,200); assert.match(await page.text(),/并发阶梯/);
});

test('随机抽样可复现、不重复，输入校验拒绝空语料和非法种子', () => {
  const entries = Array.from({length:20}, (_,i)=>({text:`测试文本 ${i}`,sourceId:`id-${i}`,sourceRecord:i+1}));
  assert.deepEqual(sampleCorpus(entries,10,123),sampleCorpus(entries,10,123));
  assert.notDeepEqual(sampleCorpus(entries,10,123),sampleCorpus(entries,10,456));
  assert.equal(new Set(sampleCorpus(entries,20,123).map(e=>e.text)).size,20);
  assert.throws(()=>sampleCorpus(entries,21,123),/不足/);
  const input = {voiceId:'v',textSource:'csv',concurrencies:'1',requests:4};
  assert.throws(()=>validateConfig(input),/未加载/);
  assert.throws(()=>validateConfig({...input,samplingSeed:0},{entries}),/种子/);
});

test('CSV 文字实际用于请求，各并发档位复用同组样本，预热另抽取并记录报告来源', async t => {
  const corpus = {sourceFile:'句子.csv',column:'合成文字',sourceSha256:'original-file-hash',entries:[
    ...Array.from({length:10},(_,i)=>({text:`测试文本第 ${i} 条，含逗号、引号“你好”及换行\n继续。`,sourceId:`media-${i}`,sourceRecord:i+1})),
    {text:'',sourceId:'empty'},{text:'测试文本第 0 条，含逗号、引号“你好”及换行\n继续。',sourceId:'duplicate'}]};
  const f = await fixture(t,corpus); const loaded = loadCorpus(f.corpusPath);
  assert.equal(loaded.entries.length,10); assert.ok(loaded.corpusSha256);
  const config = await f.call('/api/config'); assert.equal(config.data.textCorpus.count,10);
  const run = await f.run({textSource:'csv',text:'这段手动输入不应该被发送',requests:3,warmup:1,samplingSeed:123});
  assert.equal(run.results.length,6); assert.equal(f.observed.bodies.length,7);
  const a = run.results.filter(r=>r.stage===0), b = run.results.filter(r=>r.stage===1);
  assert.deepEqual(a.map(r=>r.text),b.map(r=>r.text)); assert.equal(new Set(a.map(r=>r.text)).size,3);
  assert.ok(!a.some(r=>r.text===f.observed.bodies[0].text));
  assert.deepEqual(f.observed.bodies.slice(1,4).map(b=>b.text),run.config.texts);
  assert.ok(run.results.every(r=>r.sourceId && r.sourceRecord && r.textChars===Array.from(r.text).length));
  assert.match(markdownReport(run),/抽样种子：123/); assert.match(markdownReport(run),/抽样来源明细/);
  assert.match(csvReport(run),/sourceRecord,sourceId/); assert.equal(run.config.textCorpus.sourceSha256,'original-file-hash');
});
