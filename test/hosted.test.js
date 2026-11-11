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
  return {records,calls,schemaCache:new Map([['memo23',{}],['logiover',{}],['dionysus',{}],['vexaloom',{}]]),
    async request(path,token,options={}) {
      calls.push({path,token,options});
      if(path==='/users/me')return {data:{id:token,username:'seller'}};
      if(path.startsWith('/key-value-stores?'))return {data:{id:'store-'+token}};
      const scoped=token+':'+path;
      if(options.method==='PUT'){records.set(scoped,JSON.parse(options.body));return null;}
      if(records.has(scoped))return structuredClone(records.get(scoped));
      const e=new Error('not found');e.status=404;throw e;
    },
    async start(adapter,input,token){calls.push({paid:true,adapter,input,token});if(token.startsWith('broke')){const e=new Error('no credit');e.status=402;throw e;}return {id:'run123',status:'RUNNING',defaultDatasetId:'dataset123'};},
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
  assert.equal(api.calls.filter(c=>c.paid).length,3); // all three scrapers, once
  assert.equal((await next.poll(w,started.job_id)).research_complete,false); // step 2: gig pages
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
  assert.equal((await client.listTools()).tools.length,20);
  const started=await client.callTool({name:'find_freelancers',arguments:{workspace_key:connected.workspace_key,buyer_need:'coffee shop logo'}});
  assert.equal(started.structuredContent.result.status,'RUNNING');
  const poll=()=>client.callTool({name:'get_research_job',arguments:{workspace_key:connected.workspace_key,job_id:started.structuredContent.result.job_id}});
  await poll();const polled=await poll();
  const market=await client.callTool({name:'analyze_search_results',arguments:{workspace_key:connected.workspace_key,job_id:started.structuredContent.result.job_id}});
  assert.equal(market.structuredContent.result.gigs_analyzed,1);assert.equal(market.structuredContent.result.first_page[0].position,1);
  assert.equal(polled.structuredContent.result.research_complete,true);
  assert.equal(api.calls.filter(c=>c.paid)[0].token,'apify_api_test123456789');
});

test('search runs every scraper, merges duplicates, and moves to the next key when one is out of credit',async()=>{
  const api=mockApify(),r=new HostedResearch(api);
  const w={owner:'o',token:'broke-a',userId:'broke-a',storeId:'s',accounts:[{token:'broke-a',userId:'broke-a'},{token:'good-b',userId:'good-b'}]};
  const started=await r.request(w,'search',{buyer_need:'ai music video',pages:5},'gigs');
  assert.deepEqual(started.actors.map(a=>[a.status,a.apify_key]),[['RUNNING',2],['RUNNING',2],['RUNNING',2]]);
  assert.equal(api.calls.find(c=>c.paid&&c.adapter==='memo23').input.maxItems,240);
  await r.poll(w,started.job_id);
  const detail=api.calls.filter(c=>c.paid).at(-1);
  assert.deepEqual([detail.adapter,detail.input.mode,detail.input.gigUrls],['vexaloom','gigDetails',['https://www.fiverr.com/seller/example']]);
  const done=await r.poll(w,started.job_id);
  assert.equal(done.research_complete,true);
  assert.equal(done.total_in_snapshot,1); // same gig URL from 3 scrapers merged
});

test('seller deep-dive runs memo23 + dionysus and combines the profile',async()=>{
  const api=mockApify(),r=new HostedResearch(api),w={owner:'o',token:'k',userId:'k',storeId:'s'};
  api.items=async()=>[
    {rowType:'seller',sellerUrl:'https://www.fiverr.com/levmusic',sellerName:'levmusic',sellerCountry:'US',level:'Top Rated Seller'},
    {gigUrl:'https://www.fiverr.com/levmusic/ai-video',sellerName:'levmusic',title:'produce an ai music video',seller_bio:'Producer for 10 years',notable_clients:['Sony']},
  ];
  const s=await r.request(w,'seller',{username:'levmusic',limit:10},'overview');
  assert.deepEqual(api.calls.filter(c=>c.paid).map(c=>c.adapter),['memo23','dionysus']);
  await r.poll(w,s.job_id);
  const o=await r.request(w,'seller',{username:'levmusic',job_id:s.job_id},'overview');
  assert.equal(o.profile.country,'US');assert.equal(o.profile.bio,'Producer for 10 years');assert.deepEqual(o.profile.notable_clients,['Sony']);
});

test('deep dive checks up to 20 sellers in one run per scraper',async()=>{
  const api=mockApify(),r=new HostedResearch(api),w={owner:'o',token:'k',userId:'k',storeId:'s'};
  await r.request(w,'sellers',{usernames:['a1','b2','c3']},'gigs');
  const paid=api.calls.filter(c=>c.paid);
  assert.deepEqual(paid.map(c=>c.adapter),['memo23','dionysus']);
  assert.deepEqual(paid[0].input.startUrls,['https://www.fiverr.com/a1','https://www.fiverr.com/b2','https://www.fiverr.com/c3']);
});

test('tag directory + keyword competition run on vexaloom; one row per keyword even for shared gigs',async()=>{
  const api=mockApify(),r=new HostedResearch(api),w={owner:'o',token:'k',userId:'k',storeId:'s'};
  api.schemaCache.set('vexaloom',{});
  await r.request(w,'tags',{tag_filter:'music-video'},'gigs');
  assert.deepEqual(api.calls.filter(c=>c.paid).at(-1).input,{mode:'sitemapDirectory',sitemapType:'tags',searchKeyword:'music-video',maxShards:2,maxItems:500});
  api.items=async()=>[
    {recordType:'marketSummary',searchQuery:'ai rap music video',totalResults:812,priceMedian:60},
    {recordType:'gigListing',searchQuery:'ai rap music video',position:1,gigUrl:'https://www.fiverr.com/a/x',title:'ai rap video',gigTags:[{name:'ai rap'}],attributes:[{type:'style',values:['cinematic']}]},
    {recordType:'gigListing',searchQuery:'ai christmas music video',position:4,gigUrl:'https://www.fiverr.com/a/x',title:'ai rap video'},
  ];
  const s=await r.request(w,'compare',{keywords:['ai rap music video','ai christmas music video']},'gigs');
  assert.equal(api.calls.filter(c=>c.paid).at(-1).input.searchQueries.length,2);
  await r.poll(w,s.job_id);
  const j=await r.job(w,s.job_id),gigs=j.rows.filter(x=>x.kind==='gig');
  assert.equal(gigs.length,2);
  assert.equal(j.rows.find(x=>x.kind==='summary').summary.total_results,812);
  assert.deepEqual([gigs[0].tags,gigs[0].metadata,gigs[0].search_position],[['ai rap'],['style: cinematic'],1]);
});

test('read progress only advances in order, so finalize can require every gig was read',async()=>{
  const api=mockApify(),r=new HostedResearch(api),w={owner:'o',token:'k',userId:'k',storeId:'s'};
  api.items=async()=>Array.from({length:25},(_,i)=>({gigUrl:`https://www.fiverr.com/s${i}/g`,title:'gig '+i}));
  const s=await r.request(w,'search',{buyer_need:'ai music video',pages:1},'gigs');
  await r.poll(w,s.job_id);await r.poll(w,s.job_id);
  const read=a=>r.request(w,'search',{buyer_need:'ai music video',pages:1,job_id:s.job_id,...a},'gigs');
  assert.equal((await read({offset:20,limit:10})).read_progress.read,0); // skipping ahead doesn't count
  assert.equal((await read({offset:0,limit:10})).read_progress.read,10);
  const last=await read({offset:10,limit:50});
  assert.deepEqual(last.read_progress,{read:25,total:25,next_offset:null});
  assert.equal(await r.readThrough(w,s.job_id),25);
});

test('Fiverr connector: free seller data first, Apify fallback, no Mira tools',async t=>{
  const { FiverrMcp } = await import('../src/fiverr-mcp.js');
  const api=mockApify(),secret=randomBytes(32).toString('hex'),calls=[];let down=false;
  const fiverr=new FiverrMcp();
  fiverr.call=async(name,args)=>{calls.push({name,args});if(down)throw new Error('down');return name==='talk_to_mira'?{reply:'hi',status:'done',turnId:'t1',workspaceKey:'mw_1',assistantNote:'x'}:name==='find_freelancers'?{sellers:[{username:'a'}]}:{ok:name};};
  const listener=makeApp({apify:api,secret,fiverr}).listen(0,'127.0.0.1');await once(listener,'listening');
  t.after(()=>new Promise(r=>listener.close(r)));
  const base='http://127.0.0.1:'+listener.address().port;
  const key=(await (await fetch(base+'/api/connect',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({apify_token:'apify_api_test123456789',consent:true})})).json()).workspace_key;
  const client=new Client({name:'t',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp')));t.after(()=>client.close());
  const call=async(name,a)=>(await client.callTool({name,arguments:{workspace_key:key,...a}})).structuredContent.result;
  const names=(await client.listTools()).tools.map(x=>x.name);
  assert.ok(names.includes('find_sellers_by_level')&&!names.some(n=>/mira/.test(n)));
  const paid=()=>api.calls.filter(c=>c.paid).length;
  const r=await call('list_seller_reviews',{username:'levmusic'});
  assert.equal(r.source,'fiverr_official_connector');assert.equal(paid(),0);
  assert.deepEqual(calls.at(-1).args,{username:'levmusic',limit:10,sort_by:'recent'});
  const lv=await call('find_sellers_by_level',{brief:'ai music video'});
  assert.deepEqual(lv.results.map(x=>x.level),['level_one_seller','level_two_seller']);
  down=true;
  const fb=await call('get_seller_profile',{username:'levmusic'});
  assert.equal(fb.status,'RUNNING');assert.ok(paid()>0); // falls back to Apify
});
