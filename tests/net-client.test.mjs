import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {requestBuffer} from '../net-client.mjs';

/** 建立只在本机运行的可控下载服务，测试结束后关闭所有连接。 */
async function fixture(t) {
  const server=http.createServer((req,res)=>{
    if(req.url==='/redirect') {res.writeHead(302,{Location:'/body'});res.end();return;}
    if(req.url==='/status') {res.writeHead(404);res.flushHeaders();return;}
    if(req.url==='/headers')return;
    res.writeHead(200,{'Content-Type':'audio/wav','Content-Length':52});res.flushHeaders();
    if(req.url==='/first-byte')return;
    if(req.url==='/ok') {res.end(Buffer.alloc(52));return;}
    res.write(Buffer.alloc(44));
    if(req.url==='/reset')setTimeout(()=>res.destroy(),20);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  return `http://127.0.0.1:${server.address().port}`;
}

/** 取得并断言带有结构化诊断的失败，不把测试异常误认为网络异常。 */
async function failure(url,options={}) {
  const result=await requestBuffer(url,{timeoutMs:140,expectedStatus:200,...options}).then(()=>null,e=>e);
  assert.ok(result instanceof Error);assert.ok(result.diagnostics);return result;
}

test('超时区分等待响应头、等待音频首字节和响应体读取',async t=>{
  const base=await fixture(t);
  const headers=await failure(base+'/headers');
  assert.equal(headers.name,'TimeoutError');assert.equal(headers.code,'ETIMEDOUT');
  assert.equal(headers.diagnostics.phase,'waiting_response');assert.equal(headers.diagnostics.httpStatus,null);
  const first=await failure(base+'/first-byte');
  assert.equal(first.diagnostics.phase,'waiting_first_byte');assert.equal(first.diagnostics.httpStatus,200);
  assert.equal(first.diagnostics.receivedBytes,0);assert.ok(first.diagnostics.responseHeadersMs>=0);
  const body=await failure(base+'/body');
  assert.equal(body.diagnostics.phase,'body_read');assert.equal(body.diagnostics.receivedBytes,44);
  assert.equal(body.diagnostics.expectedBytes,52);assert.equal(body.diagnostics.contentType,'audio/wav');
  assert.ok(body.diagnostics.firstByteMs>=0);assert.ok(body.diagnostics.phaseDurationsMs.body_read>0);
});

test('下载诊断保留重定向链、原 URL 和失败时最终 URL',async t=>{
  const base=await fixture(t);const error=await failure(base+'/redirect');
  assert.equal(error.diagnostics.originalUrl,base+'/redirect');
  assert.equal(error.diagnostics.currentUrl,base+'/body');assert.equal(error.diagnostics.phase,'body_read');
  assert.equal(error.diagnostics.redirects.length,1);assert.equal(error.diagnostics.redirects[0].status,302);
  assert.equal(error.diagnostics.receivedBytes,44);assert.equal(error.diagnostics.hops.length,2);
});

test('DNS 尚未返回时准确记录 DNS 阶段，连接拒绝记录 TCP 连接阶段',async()=>{
  const dns=await failure('http://mock.invalid/audio',{lookup:()=>{},agent:false});
  assert.equal(dns.diagnostics.phase,'dns_lookup');
  const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const port=server.address().port;await new Promise(r=>server.close(r));
  const refused=await failure(`http://127.0.0.1:${port}/audio`);
  assert.equal(refused.code,'ECONNREFUSED');assert.equal(refused.diagnostics.phase,'tcp_connect');
});

test('TCP 已连接而 TLS 尚未握手完成时标记 TLS 握手超时',async t=>{
  const sockets=new Set();
  const server=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(r=>server.close(r));});
  const error=await failure(`https://127.0.0.1:${server.address().port}/audio`);
  assert.equal(error.diagnostics.phase,'tls_handshake');assert.equal(error.name,'TimeoutError');
});

test('HTTP 状态异常立即失败，响应体提前断流保留已接收字节',async t=>{
  const base=await fixture(t);const status=await failure(base+'/status');
  assert.equal(status.code,'HTTP_404');assert.equal(status.diagnostics.phase,'http_status');
  assert.equal(status.diagnostics.httpStatus,404);assert.notEqual(status.name,'TimeoutError');
  const reset=await failure(base+'/reset');assert.equal(reset.code,'ERR_RESPONSE_ABORTED');
  assert.equal(reset.diagnostics.phase,'body_read');assert.equal(reset.diagnostics.receivedBytes,44);
});

test('复用连接不虚构 DNS/TCP/TLS 耗时，共享取消原因不会覆盖各请求诊断',async t=>{
  const base=await fixture(t);const agent=new http.Agent({keepAlive:true,maxSockets:1});t.after(()=>agent.destroy());
  await requestBuffer(base+'/ok',{timeoutMs:1000,agent});
  const reuse=await failure(base+'/first-byte',{agent});
  assert.equal(reuse.diagnostics.reusedConnection,true);
  assert.ok(!reuse.diagnostics.events.some(e=>['dns_lookup','tcp_connect','tls_handshake'].includes(e.phase)));
  const controller=new AbortController();
  const a=failure(base+'/headers',{signal:controller.signal,timeoutMs:1000});
  const b=failure(base+'/body',{signal:controller.signal,timeoutMs:1000});
  setTimeout(()=>controller.abort(new Error('手动停止')),80);
  const [first,second]=await Promise.all([a,b]);
  assert.equal(first.diagnostics.phase,'waiting_response');assert.equal(second.diagnostics.phase,'body_read');
  assert.notEqual(first.diagnostics,second.diagnostics);assert.equal(second.diagnostics.receivedBytes,44);
});

test('连接池没有可用槽位时，超时归类为等待可用连接',async t=>{
  const base=await fixture(t);const agent=new http.Agent({keepAlive:true,maxSockets:1});t.after(()=>agent.destroy());
  const controller=new AbortController();
  const occupied=requestBuffer(base+'/body',{timeoutMs:1500,agent,signal:controller.signal}).catch(e=>e);
  const started=Date.now();
  const error=await failure(base+'/ok',{agent});
  assert.equal(error.diagnostics.phase,'waiting_socket');assert.equal(error.diagnostics.httpStatus,null);
  assert.ok(Date.now()-started<500,'等待 socket 时也必须按自身截止时间结束');
  controller.abort(new Error('清理本地模拟连接'));await occupied;
});
