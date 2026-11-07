import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const entry=resolve('src/index.js');
function environment(t) {
  const dir=mkdtempSync(join(tmpdir(),'fiverr-transport-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  return {...process.env,WORKSPACES_FILE:'',WORKSPACE_KEY:'transport-test-key-at-least-24-chars',APIFY_TOKEN:'',DATA_DIR:dir,HOST:'127.0.0.1',PUBLIC_HOST:''};
}
test('stdio client can initialize, list tools and receive honest credential error',async t=>{
  const env=environment(t),client=new Client({name:'stdio-test',version:'1'});
  const transport=new StdioClientTransport({command:process.execPath,args:[entry,'--stdio'],env,stderr:'pipe'});
  t.after(()=>client.close());
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length,16);
  const r=await client.callTool({name:'find_freelancers',arguments:{workspace_key:env.WORKSPACE_KEY,buyer_need:'coffee shop logo'}});
  assert.equal(r.isError,true);assert.match(r.content[0].text,/APIFY_TOKEN/);
  assert.equal((await client.listPrompts()).prompts[0].name,'create_fiverr_gig');
  assert.ok((await client.readResource({uri:'fiverr-gig://workflow'})).contents[0].text.includes('1200'));
});
test('HTTP MCP client connects; host/origin and method guards work',async t=>{
  const env=environment(t);
  const portProbe=createServer();portProbe.listen(0,'127.0.0.1');await once(portProbe,'listening');
  const port=portProbe.address().port;await new Promise(r=>portProbe.close(r));
  const child=spawn(process.execPath,[entry],{env:{...env,PORT:String(port)},stdio:['ignore','pipe','pipe'],windowsHide:true});
  t.after(async()=>{if(child.exitCode===null){const stopped=once(child,'exit');child.kill();await stopped;}});
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Server startup timeout')),10000);
    child.stderr.on('data',data=>{if(data.toString().includes('ready')){clearTimeout(timeout);resolve();}});
    child.on('exit',code=>{clearTimeout(timeout);reject(new Error(`Server exited ${code}`));});
  });
  const url=`http://127.0.0.1:${port}`;
  assert.equal((await fetch(url+'/health')).status,200);
  const client=new Client({name:'http-test',version:'1'});
  t.after(()=>client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(url+'/mcp')));
  assert.equal((await client.listTools()).tools.length,16);
  const brief=await client.callTool({name:'prepare_gig_brief',arguments:{service:'Website redesign'}});
  assert.equal(brief.structuredContent.result.rules.title.exact,78);
  assert.equal((await fetch(url+'/mcp',{method:'GET'})).status,405);
  assert.equal((await fetch(url+'/mcp',{method:'POST',headers:{origin:'https://evil.test','content-type':'application/json'},body:'{}'})).status,403);
  const rejectedHost = await new Promise((resolve,reject)=>{
    const req=request(url+'/health',{headers:{Host:'evil.test'}},res=>{res.resume();resolve(res.statusCode);});
    req.on('error',reject);req.end();
  });
  assert.equal(rejectedHost,403);
});
