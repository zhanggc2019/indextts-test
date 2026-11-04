import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';

// 连接数量随工作池并发增长，避免大于 64 时在客户端连接池中被隐式排队。
const agents = { 'http:':new http.Agent({keepAlive:true,maxSockets:Infinity,maxFreeSockets:64}), 'https:':new https.Agent({keepAlive:true,maxSockets:Infinity,maxFreeSockets:64}) };

/** 完整记录单次 HTTP 链条，统一截止时间覆盖 DNS、连接、重定向及响应读取。 */
export async function requestBuffer(url, {method='GET',headers={},body,timeoutMs,signal,maxBytes=50*1024*1024,redirects=0,expectedStatus,lookup,agent}={}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('请求超时必须是有效的正数');
  const start=performance.now(), controller=new AbortController();
  const trace={originalUrl:String(url),currentUrl:String(url),phase:'url_validation',phaseStartedMs:0,
    elapsedMs:0,receivedBytes:0,totalReceivedBytes:0,expectedBytes:null,httpStatus:null,
    responseHeadersMs:null,firstByteMs:null,reusedConnection:false,phaseDurationsMs:{},events:[],redirects:[],hops:[]};
  /** 记录阶段转换及前一阶段耗时，时间均相对最初请求起点。 */
  function phase(name) {
    const now=performance.now()-start;
    if (trace.phase===name && trace.events.length) return;
    trace.phaseDurationsMs[trace.phase]=(trace.phaseDurationsMs[trace.phase]||0)+now-trace.phaseStartedMs;
    trace.phase=name; trace.phaseStartedMs=now;
    trace.events.push({phase:name,atMs:now,url:trace.currentUrl});
  }
  const timer=setTimeout(()=>{
    const error=new Error(`请求超时（${timeoutMs/1000} 秒）`); error.name='TimeoutError'; error.code='ETIMEDOUT';
    controller.abort(error);
  },timeoutMs);
  /** 把用户取消传递给当前连接，取消不会伪装成超时。 */
  function abort() { controller.abort(signal.reason || new Error('用户取消')); }
  if(signal?.aborted) abort(); else signal?.addEventListener('abort',abort,{once:true});
  try {
    const result=await requestOnce(url,{method,headers,body,maxBytes,redirects,expectedStatus,lookup,agent,signal:controller.signal,start,trace,phase});
    trace.elapsedMs=performance.now()-start;
    return {...result,diagnostics:structuredClone(trace)};
  } catch(cause) {
    // 每条请求独立复制错误，防止多并发共享 AbortSignal.reason 时覆盖彼此的诊断。
    const error=new Error(cause?.message || String(cause));
    error.name=cause?.name || 'Error'; error.code=cause?.code || 'NETWORK_ERROR';
    trace.elapsedMs=performance.now()-start;
    const copy=structuredClone(trace);
    copy.phaseDurationsMs[copy.phase]=(copy.phaseDurationsMs[copy.phase]||0)+trace.elapsedMs-copy.phaseStartedMs;
    error.diagnostics=copy; throw error;
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}

/** 执行一跳请求；只监听本跳 socket，完成后清理，避免复用连接残留监听器。 */
function requestOnce(url,options) {
  const {trace,phase}=options;
  return new Promise((resolve,reject)=>{
    trace.currentUrl=String(url); phase('url_validation');
    let u;
    try {u=new URL(url);} catch {const error=new Error('音频 URL 格式无效');error.code='INVALID_URL';return reject(error);}
    if(!['http:','https:'].includes(u.protocol)||u.username||u.password) {
      const error=new Error('不支持的音频 URL');error.code='INVALID_URL';return reject(error);
    }
    trace.currentUrl=u.href; trace.httpStatus=null; trace.receivedBytes=0; trace.expectedBytes=null;
    trace.responseHeadersMs=null; trace.firstByteMs=null; trace.contentType=null; trace.reusedConnection=false;
    const hop={url:u.href,startedMs:performance.now()-options.start,status:null,receivedBytes:0};trace.hops.push(hop);
    phase('waiting_socket');
    let settled=false,socket;
    const listeners=[];
    /** 清理仅属于当前请求的连接事件监听器。 */
    function cleanup() {
      for(const [event,listener] of listeners) socket?.removeListener(event,listener);
      options.signal.removeEventListener('abort',cancel);
    }
    /** 只结算一次错误，并优先保留总截止时间或用户取消的原因。 */
    function fail(error) {
      if(settled)return; settled=true; cleanup();
      reject(options.signal.aborted ? options.signal.reason : error);
    }
    /** 排队中的请求也立即结算取消，不能等待连接池分配 socket 后才报超时。 */
    function cancel() {fail(options.signal.reason);}
    /** 注册连接事件并跟踪，连接复用时不保留旧请求回调。 */
    function listen(event,listener) {socket.once(event,listener);listeners.push([event,listener]);}
    const transport=u.protocol==='https:'?https:http;
    let req;
    if(options.signal.aborted) {fail(options.signal.reason);return;}
    options.signal.addEventListener('abort',cancel,{once:true});
    try {
      req=transport.request(u,{method:options.method,headers:options.headers,agent:options.agent===undefined?agents[u.protocol]:options.agent,
        signal:options.signal,lookup:options.lookup},res=>{
        res.once('error',fail);
        trace.httpStatus=res.statusCode; hop.status=res.statusCode;
        trace.responseHeadersMs=performance.now()-options.start; hop.responseHeadersMs=trace.responseHeadersMs;
        trace.contentType=res.headers['content-type']||null;
        const size=res.headers['content-length'];
        trace.expectedBytes=size!=null&&Number.isFinite(Number(size))?Number(size):null;
        phase('waiting_first_byte');
        if([301,302,303,307,308].includes(res.statusCode)&&res.headers.location) {
          phase('redirect');
          let next;
          try {next=new URL(res.headers.location,u).href;} catch {const e=new Error('重定向 URL 无效');e.code='INVALID_REDIRECT';fail(e);res.destroy();return;}
          trace.redirects.push({from:u.href,to:next,status:res.statusCode,atMs:performance.now()-options.start});
          if(options.method!=='GET'||Object.keys(options.headers).some(k=>k.toLowerCase()==='x-api-key')) {
            const e=new Error('拒绝转发带密钥的重定向');e.code='UNSAFE_REDIRECT';fail(e);res.destroy();return;
          }
          if(options.redirects>=5) {const e=new Error('下载重定向超过 5 次');e.code='TOO_MANY_REDIRECTS';fail(e);res.destroy();return;}
          settled=true;cleanup();res.destroy();
          resolve(requestOnce(next,{...options,redirects:options.redirects+1}));return;
        }
        if(options.expectedStatus!=null&&res.statusCode!==options.expectedStatus) {
          phase('http_status');const e=new Error(`下载 HTTP ${res.statusCode}`);e.code=`HTTP_${res.statusCode}`;
          fail(e);res.destroy();return;
        }
        const chunks=[];let sizeRead=0;
        res.on('data',chunk=>{
          if(!chunk.length)return;
          if(trace.firstByteMs===null)trace.firstByteMs=performance.now()-options.start;
          phase('body_read');sizeRead+=chunk.length;
          trace.receivedBytes=sizeRead;trace.totalReceivedBytes+=chunk.length;hop.receivedBytes=sizeRead;
          if(sizeRead>options.maxBytes) {const e=new Error('响应超过大小限制');e.code='RESPONSE_TOO_LARGE';fail(e);res.destroy();return;}
          chunks.push(chunk);
        });
        res.once('aborted',()=>{const e=new Error('响应体传输提前中断');e.code='ERR_RESPONSE_ABORTED';fail(e);});
        res.once('end',()=>{
          if(settled)return;
          if(!res.complete) {const e=new Error('响应体未完整接收');e.code='INCOMPLETE_RESPONSE';fail(e);return;}
          settled=true;cleanup();phase('complete');
          resolve({status:res.statusCode,headers:res.headers,buffer:Buffer.concat(chunks),ms:performance.now()-options.start,ttfb:trace.firstByteMs});
        });
      });
    } catch(error) {fail(error);return;}
    req.once('socket',value=>{
      socket=value;trace.reusedConnection=Boolean(req.reusedSocket);hop.reusedConnection=trace.reusedConnection;
      /** 连接可发送时，根据请求是否已刷出切换至发送或等待响应。 */
      function ready() {
        trace.remoteAddress=socket.remoteAddress||null;
        phase(req.writableFinished?'waiting_response':'request_send');
      }
      if(req.reusedSocket||!socket.connecting) {ready();return;}
      phase(isIP(u.hostname.replace(/^\[|\]$/g,''))?'tcp_connect':'dns_lookup');
      listen('lookup',error=>{hop.lookupMs=performance.now()-options.start;if(!error)phase('tcp_connect');});
      listen('connect',()=>{hop.connectedMs=performance.now()-options.start;trace.remoteAddress=socket.remoteAddress||null;
        if(u.protocol==='https:')phase('tls_handshake');else ready();});
      if(u.protocol==='https:')listen('secureConnect',()=>{hop.secureMs=performance.now()-options.start;ready();});
    });
    req.once('finish',()=>{hop.requestSentMs=performance.now()-options.start;if(trace.phase==='request_send')phase('waiting_response');});
    req.once('error',fail);
    if(options.body)req.write(options.body);req.end();
  });
}
