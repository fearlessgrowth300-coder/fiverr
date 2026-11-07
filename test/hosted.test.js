import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { Credentials } from '../src/credentials.js';
import { HostedResearch } from '../src/hosted-research.js';
import { makeApp } from '../app.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function mockApify(){
  const records=new Map(),calls=[];
  return {records,calls,schemaCache:new Map([['memo23',{}]]),
    async request(path,token,options={}) {
      calls.push({path,token,options});
      if(path==='/users/me')return {data:{id:token,username:'seller'}};
      if(path.startsWith('/key-value-stores?'))return {data:{id:'store-'+token}};
      const scoped=token+':'+path;
      if(options.method==='PUT'){records.set(scoped,JSON.parse(options.body));return null;}
      if(records.has(scoped))return structuredClone(records.get(scoped));
      const e=new Error('not found');e.status=404;throw e;
    },
    async start(adapter,input,token){calls.push({paid:true,adapter,input,token});return {id:'run123',status:'RUNNING',defaultDatasetId:'dataset123'};},
    async poll(id,token){return {id,userId:token,status:'SUCCEEDED',defaultDatasetId:'dataset123'};},
    async items(id,token){return [{rowType:'gig',sellerName:'seller',gigUrl:'https://www.fiverr.com/seller/example',title:'Example',description:'Public research evidence'}];}
  };
}
test('workspace credential is encrypted, authenticated, expires and rejects another key',()=>{
  const c=new Credentials(randomBytes(32).toString('hex'));
  const key=c.issue({token:'secret-apify-token',userId:'u1',storeId:'s1'},1000);
  assert.ok(!key.includes('secret-apify-token'));assert.ok(!Buffer.from(key.slice(5),'base64url').toString().includes('secret-apify-token'));
  assert.equal(c.read(key,2000).userId,'u1');
  assert.throws(()=>c.read(key,1000+91*86400000),/expired/);
  const parts=Buffer.from(key.slice(5),'base64url');parts[30]^=1;
  assert.throws(()=>c.read('fgs1.'+parts.toString('base64url'),2000),/invalid/);
  assert.throws(()=>new Credentials(randomBytes(32).toString('hex')).read(key,2000),/invalid/);
});
test('hosted jobs persist across instances without mixing sellers or saving tokens',async()=>{
  const api=mockApify(),first=new HostedResearch(api),w={owner:'owner-a',token:'account-a',userId:'account-a',storeId:'store-a'};
  const args={buyer_need:'coffee shop logo',limit:10};
  const started=await first.request(w,'search',args,'gigs');
  const next=new HostedResearch(api);
  assert.equal((await next.request(w,'search',args,'gigs')).job_id,started.job_id);
  assert.equal(api.calls.filter(c=>c.paid).length,1);
  assert.equal((await next.poll(w,started.job_id)).research_complete,true);
  const foreign={owner:'owner-b',token:'account-b',storeId:'store-b'};
  await assert.rejects(()=>next.job(foreign,started.job_id));
  for(const call of api.calls.filter(c=>c.options?.method==='PUT'))assert.ok(!call.options.body.includes('account-a'));
});
test('web connect consent, isolation and hosted MCP roundtrip',async t=>{
  const api=mockApify(),secret=randomBytes(32).toString('hex');
  const listener=makeApp({apify:api,secret}).listen(0,'127.0.0.1');await once(listener,'listening');
  t.after(()=>new Promise(r=>listener.close(r)));
  const base='http://127.0.0.1:'+listener.address().port;
  const connect=body=>fetch(base+'/api/connect',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await connect({apify_token:'apify_api_test123456789'})).status,400);
  assert.equal((await fetch(base+'/api/connect',{method:'POST',headers:{origin:'https://evil.test','content-type':'application/json'},body:'{}'})).status,403);
  const response=await connect({apify_token:'apify_api_test123456789',consent:true});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  const connected=await response.json();assert.ok(connected.workspace_key.startsWith('fgs1.'));
  const client=new Client({name:'hosted-test',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp')));t.after(()=>client.close());
  assert.equal((await client.listTools()).tools.length,15);
  const started=await client.callTool({name:'find_freelancers',arguments:{workspace_key:connected.workspace_key,buyer_need:'coffee shop logo'}});
  assert.equal(started.structuredContent.result.status,'RUNNING');
  const polled=await client.callTool({name:'get_research_job',arguments:{workspace_key:connected.workspace_key,job_id:started.structuredContent.result.job_id}});
  assert.equal(polled.structuredContent.result.research_complete,true);
  assert.equal(api.calls.filter(c=>c.paid)[0].token,'apify_api_test123456789');
});
