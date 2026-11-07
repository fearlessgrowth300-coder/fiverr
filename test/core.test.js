import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateGig, count } from '../src/validation.js';
import { Store, hash, authorize } from '../src/storage.js';
import { normalize, viewJob, fiverrUrl } from '../src/normalize.js';
import { Apify, actorInput } from '../src/apify.js';
import { Research } from '../src/research.js';
import { createServer } from '../src/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const key = 'test-workspace-key-at-least-24-chars';
const workspace = { owner:hash(key), token:'test-apify-secret' };
const fixtureRow = { rowType:'gig', title:'Example service', gigUrl:'https://www.fiverr.com/example/service', sellerName:'example', rating:4.9, reviewsCount:100, sellerRating:4.8, sellerRatingCount:120, priceFrom:25, topReviews:[{text:'Helped clarify my brand',rating:5}] };
const tier = price => ({ name:'Clear scope', description:'A focused service', price_usd:price, delivery_days:3, revisions:1, deliverables:['One deliverable'], exclusions:['Additional work'] });
function fixtureGig() {
  return { profile:{about:'I help buyers with clear service delivery.',skills:['Design'],facts_to_confirm:['Experience']}, title:'I will '+ 'a'.repeat(71), category:'Graphics & Design',subcategory:'Logo Design',category_verified:false,tags:['logo','brand','design','business','identity'],packages:{basic:tier(25),standard:tier(50),premium:tier(100)},pricing_rationale:'Proposed pricing pending scope confirmation.',description:'x'.repeat(1200),faq:[{question:'What is included?',answer:'The stated scope.'}],images:[{headline:'Clear identity',supporting_text:'Business logos',layout:'Large headline',visual_concept:'Original artwork',buyer_relevance:'Clear offer',thumbnail_check:'Readable'}],requirements:[{question:'What is your business?',required:true,response_type:'free_text'}],buyer_hypothesis:'Buyers need an identity.',evidence:[],limitations:['No live research'],next_question:'What style fits your business?' };
}
function setup(t, config={}) {
  const dir=mkdtempSync(join(tmpdir(),'fiverr-mcp-test-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const store=new Store(dir);
  const calls=[];
  const apify={start:async(...args)=>{calls.push(args);return {id:'run1',defaultDatasetId:'data1',status:'RUNNING'};},poll:async()=>({status:'SUCCEEDED',defaultDatasetId:'data1'}),items:async()=>[fixtureRow]};
  return {store,calls,apify,research:new Research(store,apify,config),dir};
}
test('exact title, tag and description requirements; Unicode counts',()=>{
  const g=fixtureGig(); assert.equal(validateGig(g).valid,true); assert.equal(count('a😀'),2);
  g.title+='b';g.description+='x';g.tags[4]='logo';
  const r=validateGig(g);assert.equal(r.valid,false);assert.equal(r.errors.length,3);
});
test('invalid package progression and missing requirement choices fail',()=>{
  const g=fixtureGig();g.packages.standard.price_usd=10;g.requirements[0].response_type='multiple_choice';
  assert.equal(validateGig(g).errors.length,2);
});
test('workspace authorization rejects wrong keys',()=>{
  assert.equal(authorize(key,[workspace]).owner,workspace.owner);
  assert.throws(()=>authorize('wrong',[workspace]),/invalid/);
});
test('normalization distinguishes gig and seller aggregates',()=>{
  const row=normalize({...fixtureRow,sellerRating:undefined,sellerRatingCount:undefined});
  assert.equal(row.gig_rating,4.9);assert.equal(row.profile.rating,null);assert.equal(row.profile.review_count,null);
});
test('URL restrictions exclude malicious host suffixes and credentials',()=>{
  assert.equal(fiverrUrl('https://fiverr.com.evil.test/seller/gig'),null);
  assert.equal(fiverrUrl('https://user:pass@www.fiverr.com/seller/gig'),null);
  assert.equal(fiverrUrl('http://www.fiverr.com/seller/gig'),null);
});
test('snapshot pagination uses actual remaining rows, not page length heuristic',()=>{
  const job={rows:[normalize(fixtureRow),normalize({...fixtureRow,gigUrl:'https://www.fiverr.com/example/other'})]};
  const first=viewJob(job,'gigs','example',0,1),second=viewJob(job,'gigs','example',1,1);
  assert.equal(first.has_next_page,true);assert.equal(second.has_next_page,false);assert.equal(second.source_has_next_page,null);
});
test('paid search deduplicates, persists and never forwards workspace key',async t=>{
  const s=setup(t);const args={buyer_need:'I need a logo for my coffee shop',limit:10,adapter:'memo23'};
  const first=await s.research.request(workspace,'search',args,'gigs');
  const again=await s.research.request(workspace,'search',args,'gigs');
  assert.equal(first.job_id,again.job_id);assert.equal(s.calls.length,1);
  assert.equal(JSON.stringify(s.calls[0][1]).includes(key),false);
  assert.equal(new Store(s.dir).get(first.job_id,workspace.owner).status,'RUNNING');
  assert.throws(()=>s.store.get(first.job_id,'another-workspace'),/not found/);
});
test('polling completes job and reviews can reuse a discovery snapshot',async t=>{
  const s=setup(t);const args={buyer_need:'coffee shop logo',limit:10};
  const j=await s.research.request(workspace,'search',args,'gigs');
  const done=await s.research.poll(workspace,j.job_id);assert.equal(done.research_complete,true);
  const reviews=await s.research.request(workspace,'seller',{username:'example',job_id:j.job_id,limit:10},'reviews');
  assert.equal(reviews.items[0].review.text,'Helped clarify my brand');assert.equal(s.calls.length,1);
});
test('daily limits stop additional billing and survive restart',async t=>{
  const s=setup(t,{maxDaily:1});await s.research.request(workspace,'search',{buyer_need:'logo',limit:1},'gigs');
  await assert.rejects(()=>s.research.request(workspace,'search',{buyer_need:'website',limit:1},'gigs'),/Daily run limit/);
  assert.equal(s.calls.length,1);
});
test('uncertain starts are reserved and do not auto-retry',async t=>{
  const s=setup(t);s.apify.start=async()=>{throw new Error('Network timeout');};
  const args={buyer_need:'logo',limit:10};
  await assert.rejects(()=>s.research.request(workspace,'search',args,'gigs'),/reserved/);
  const again=await s.research.request(workspace,'search',args,'gigs');assert.equal(again.status,'START_UNCERTAIN');
});
test('failed run data is explicitly partial',async t=>{
  const s=setup(t);s.apify.poll=async()=>({status:'FAILED',defaultDatasetId:'data1'});
  const j=await s.research.request(workspace,'search',{buyer_need:'logo',limit:10},'gigs');
  const r=await s.research.poll(workspace,j.job_id);assert.equal(r.partial_results,true);assert.equal(r.research_complete,false);
});
test('foreign or invented evidence is rejected',async t=>{
  const s=setup(t);const j=await s.research.request(workspace,'search',{buyer_need:'logo',limit:10},'gigs');await s.research.poll(workspace,j.job_id);
  assert.equal(s.research.evidenceErrors(workspace,[{job_id:j.job_id,source_url:fixtureRow.gigUrl}]).length,0);
  assert.equal(s.research.evidenceErrors(workspace,[{job_id:j.job_id,source_url:'https://example.com'}]).length,1);
  assert.equal(s.research.evidenceErrors({owner:'foreign'},[{job_id:j.job_id,source_url:fixtureRow.gigUrl}]).length,1);
});
test('Apify API uses bearer auth, cost cap and only mapped input',async()=>{
  const calls=[];
  const api=new Apify(async(url,options)=>{calls.push({url,options});return {ok:true,status:201,text:async()=>JSON.stringify({data:{id:'run1',status:'RUNNING'}})};});
  api.schemaCache.set('memo23',{properties:{searchQueries:{},scrapeDetails:{},maxItems:{},maxItemsPerSearch:{},maxConcurrency:{}}});
  await api.start('memo23',actorInput('memo23','search',{buyer_need:'logo',limit:5}),'private-token',0.5);
  assert.equal(calls[0].options.headers.Authorization,'Bearer private-token');
  assert.equal(calls[0].url.includes('private-token'),false);assert.match(calls[0].url,/maxTotalChargeUsd=0.5/);
});
test('MCP discovery, workflow, validation, and research work through official client',async t=>{
  const s=setup(t);const server=createServer({workspaces:[workspace],research:s.research,apify:s.apify});
  const client=new Client({name:'integration-test',version:'1'});
  const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
  t.after(async()=>{await client.close();await server.close();});
  const tools=await client.listTools();assert.equal(tools.tools.length,15);
  for(const name of ['find_freelancers','get_freelancer_overview','get_seller_profile','get_seller_reviews_summary','list_seller_gigs','list_seller_reviews']) assert.ok(tools.tools.some(x=>x.name===name));
  const brief=await client.callTool({name:'prepare_gig_brief',arguments:{service:'Logo design'}});assert.ok(brief.structuredContent.result.instructions.includes('1200'));
  const invalid=await client.callTool({name:'find_freelancers',arguments:{workspace_key:'wrong-key-with-at-least-24-characters',buyer_need:'logo design'}});assert.equal(invalid.isError,true);
  const start=await client.callTool({name:'find_freelancers',arguments:{workspace_key:key,buyer_need:'logo design'}});assert.equal(start.structuredContent.result.status,'RUNNING');
  const final=await client.callTool({name:'finalize_gig_package',arguments:{workspace_key:key,gig:fixtureGig()}});assert.equal(final.structuredContent.result.valid,true);assert.ok(final.structuredContent.result.markdown.includes('## Buyer requirements'));
});
