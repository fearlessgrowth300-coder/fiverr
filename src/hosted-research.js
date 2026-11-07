import { randomUUID } from 'node:crypto';
import { ACTORS, actorInput } from './apify.js';
import { normalize, viewJob, rowsFor, fiverrUrl } from './normalize.js';
import { hash } from './storage.js';

const terminal=new Set(['SUCCEEDED','FAILED','ABORTED','TIMED-OUT']);
const fillGaps=(a,b)=>{for(const [k,v] of Object.entries(b)){if(a[k]==null||(Array.isArray(a[k])&&!a[k].length))a[k]=v;else if(k==='profile'&&v)fillGaps(a[k],v);}return a;};
const done=r=>terminal.has(r.status)||(r.status==='START_UNCERTAIN'&&!r.runId);
// Apify statuses that mean "this key can't run right now" (revoked, out of credit, plan/actor limit, rate limit) -> try the next key.
const rotate=new Set([401,402,403,429]);
// Keep stored snapshots well under Apify's key-value record size limit.
const compact=row=>({...row,description:row.description?.slice(0,4000)??null,reviews:row.reviews.slice(0,10)});

export class HostedResearch {
  constructor(apify,{maxCharge=1.5}={}) {this.apify=apify;this.maxCharge=maxCharge;}
  accounts(w) {return w.accounts?.length?w.accounts:[{token:w.token,userId:w.userId}];}
  // ponytail: job storage lives on the FIRST key's Apify account; if that account is blocked, storage fails too.
  path(w,key) {return `/key-value-stores/${encodeURIComponent(w.storeId)}/records/${encodeURIComponent(key)}`;}
  async get(w,key,optional=false) {
    try {return await this.apify.request(this.path(w,key),w.token);}
    catch(e) {if(optional&&e.status===404)return null;throw e;}
  }
  async put(w,key,data) {await this.apify.request(this.path(w,key),w.token,{method:'PUT',body:JSON.stringify(data)});}
  async job(w,id) {
    const j=await this.get(w,'job-'+id);
    if(!j || j.owner!==w.owner) throw new Error('Research job not found in this workspace.');
    j.runs??=[{adapter:j.adapter,actor:j.actor,runId:j.runId,datasetId:j.datasetId,status:j.status,a:0}];
    return j;
  }
  runInfo(j) {return j.runs.map(r=>({actor:r.actor,status:r.status,apify_key:r.a+1,...(r.error?{error:r.error}:{})}));}
  result(j,view,args={}) {
    if(!j.rows) return {job_id:j.id,status:j.status,actors:this.runInfo(j),next_step:'Research is running (10-20 min for 5 pages). Tell the user it is running, then poll get_research_job with this job_id. Do NOT use web search or browse Fiverr meanwhile, and do not start a new run.'};
    return {...viewJob(j,view,args.username,args.offset||0,args.limit||10),actors:this.runInfo(j),partial_results:j.status!=='SUCCEEDED'};
  }
  // Start one Actor, moving to the next Apify key when a key is refused.
  async startRun(w,adapter,input) {
    const accounts=this.accounts(w),r={adapter,actor:ACTORS[adapter].id,status:'STARTING'};
    let last;
    for(let a=0;a<accounts.length;a++) {
      try {
        const run=await this.apify.start(adapter,input,accounts[a].token,this.maxCharge);
        return {...r,a,runId:run.id,datasetId:run.defaultDatasetId,status:run.status};
      } catch(e) {
        last=e;
        if(!e.status) return {...r,a,status:'START_UNCERTAIN',error:'Network failure while starting; check Apify Console before retrying.'};
        if(!rotate.has(e.status)) break;
      }
    }
    return {...r,status:'FAILED',error:`All ${accounts.length} Apify key(s) refused this scraper (last HTTP ${last?.status}). Check balance/plan.`};
  }
  async request(w,mode,args,view) {
    if(args.job_id) {
      const j=await this.job(w,args.job_id);
      if(mode==='seller' ? j.username!==args.username&&!rowsFor(j,args.username).length : j.mode!==mode) throw new Error('Job does not match requested seller or research scope.');
      const out=this.result(j,view,args);
      if(mode!=='search'||view!=='gigs'||!j.rows) return out;
      // Track how far the AI has read, in order (no skipping), so finalize can require every gig was read.
      const read=await this.readThrough(w,j.id),offset=args.offset||0,seen=Math.min(offset+(args.limit||10),out.total_in_snapshot);
      const now=offset<=read&&seen>read?seen:read;
      if(now>read) await this.put(w,'read-'+j.id,{n:now});
      return {...out,read_progress:{read:now,total:out.total_in_snapshot,next_offset:now<out.total_in_snapshot?now:null}};
    }
    // Searches run every Fiverr scraper in parallel unless one is named; other lookups use one.
    const adapters=args.adapter?[args.adapter]:mode==='tags'||mode==='compare'?['vexaloom']:mode==='search'?(args.quick?['logiover']:['memo23','logiover','dionysus']):mode==='seller'||mode==='sellers'?['memo23','dionysus']:['memo23'];
    const inputs=adapters.map(ad=>actorInput(ad,mode,args));
    for(const ad of adapters) if(!this.apify.schemaCache.has(ad))await this.apify.inspect(ad);
    const fingerprint=hash(JSON.stringify(['v2',adapters,inputs]));
    const cached=await this.get(w,'query-'+fingerprint,true);
    if(cached && Date.now()-Date.parse(cached.createdAt)<3600000) {
      const j=await this.job(w,cached.id);
      if(j.runs.some(r=>!['FAILED','TIMED-OUT','ABORTED'].includes(r.status))) return this.result(j,view,args);
    }
    const j={id:randomUUID(),owner:w.owner,mode,quick:!!args.quick,username:args.username,query:mode==='search'?args.buyer_need:undefined,status:'STARTING',createdAt:new Date().toISOString(),
      limit:mode==='search'&&args.pages?args.pages*48:mode==='sellers'?args.usernames.length*10:Math.min(args.limit||10,50),runs:adapters.map(ad=>({adapter:ad,actor:ACTORS[ad].id,status:'STARTING'}))};
    await this.put(w,'job-'+j.id,j);
    await this.put(w,'query-'+fingerprint,{id:j.id,createdAt:j.createdAt});
    j.runs=await Promise.all(adapters.map((ad,i)=>this.startRun(w,ad,inputs[i])));
    j.status=j.runs.every(r=>r.status==='FAILED')?'FAILED':'RUNNING';
    await this.put(w,'job-'+j.id,j);
    if(j.status==='FAILED') throw new Error(`No scraper could start. ${j.runs.map(r=>r.error).join(' ')}`);
    if(j.runs.some(r=>r.status==='START_UNCERTAIN')&&j.runs.every(r=>r.status==='START_UNCERTAIN'||r.status==='FAILED'))
      throw new Error(`Research job ${j.id} has an uncertain start. Check Apify Console before retrying; use recover_research_job to avoid duplicate charges.`);
    return this.result(j,view,args);
  }
  // Merge every run's rows by gig URL. Search runs decide order (best position any scraper saw);
  // the detail run only fills gaps (tags, description, FAQ, orders in queue).
  async collect(j,accounts) {
    const merged=new Map(),loose=[];
    const runs=[...j.runs].sort((x,y)=>(x.phase==='details')-(y.phase==='details'));
    for(const r of runs) {
      if(!r.datasetId) continue;
      const acc=accounts[r.a]||accounts[0];
      const items=await this.apify.items(r.datasetId,acc.token,0,1000);
      items.forEach((raw,i)=>{
        const row=compact({...normalize(raw),source_actor:r.actor}),idx=r.phase==='details'?Infinity:i;
        const key=row.source_url&&(j.mode==='compare'?row.search_query+'|':'')+row.source_url,prev=key&&merged.get(key);
        if(!row.source_url) loose.push(row);
        else if(!prev) {if(r.phase!=='details')merged.set(key,{...row,_idx:idx});}
        else {prev._idx=Math.min(prev._idx,idx);fillGaps(prev,row);}
      });
    }
    const rows=[...merged.values()].sort((x,y)=>x._idx-y._idx);
    let n=0;for(const r of rows){delete r._idx;if(r.kind==='gig'){r.position=++n;r.page=n<=j.limit?Math.ceil(n/48):null;if(!r.page)r.extra_from_other_scrapers=true;}}
    return [...rows,...loose];
  }
  async poll(w,id) {
    const j=await this.job(w,id),accounts=this.accounts(w);
    if(j.rows)return {...this.result(j,'gigs'),research_complete:true};
    for(const r of j.runs) {
      if(done(r)||!r.runId) continue;
      const acc=accounts[r.a]||accounts[0];
      const run=await this.apify.poll(r.runId,acc.token);
      if(run.userId && run.userId!==acc.userId) throw new Error('Run ownership mismatch.');
      r.status=run.status;r.datasetId=run.defaultDatasetId||r.datasetId;
    }
    if(!j.runs.every(done)) {j.status='RUNNING';await this.put(w,'job-'+j.id,j);return {...this.result(j,'gigs'),stage:j.stage||'searching Fiverr pages',research_complete:false};}
    // Step 2: after pages 1-5 are collected, open every gig page (in rank order) for tags + full details.
    if(j.mode==='search'&&!j.quick&&!j.detailsStarted) {
      j.detailsStarted=true;
      const urls=(await this.collect(j,accounts)).filter(r=>r.kind==='gig'&&r.source_url).slice(0,j.limit).map(r=>r.source_url);
      if(urls.length) {
        const d=await this.startRun(w,'vexaloom',actorInput('vexaloom','gig',{urls,limit:urls.length}));
        j.runs.push({...d,phase:'details'});
        if(!done(d)) {j.status='RUNNING';j.stage=`opening ${urls.length} gig pages for tags, descriptions, prices, FAQ, reviews`;await this.put(w,'job-'+j.id,j);return {...this.result(j,'gigs'),stage:j.stage,research_complete:false};}
      }
    }
    j.rows=await this.collect(j,accounts);j.collectedAt=new Date().toISOString();j.stage='complete';
    j.status=j.runs.every(r=>r.status==='SUCCEEDED')?'SUCCEEDED':j.runs.some(r=>r.status==='SUCCEEDED')?'PARTIAL':'FAILED';
    await this.put(w,'job-'+j.id,j);
    return {...this.result(j,'gigs'),research_complete:true,next_step:'Call analyze_search_results with this job_id, then read every gig in order with find_freelancers(job_id, offset) until has_next_page=false.'};
  }
  async recover(w,id,runId,confirmedNotStarted) {
    const j=await this.job(w,id),accounts=this.accounts(w);
    const open=j.runs.filter(r=>['STARTING','START_UNCERTAIN'].includes(r.status));
    if(!open.length)throw new Error('Only uncertain starts can be recovered.');
    if(runId) {
      let found;
      for(let a=0;a<accounts.length&&!found;a++) {
        try {
          const run=await this.apify.poll(runId,accounts[a].token);
          for(const r of open) {
            const actor=await this.apify.request(`/acts/${r.actor.replace('/','~')}`,accounts[a].token);
            if(run.actId===actor.data.id&&run.userId===accounts[a].userId){found=Object.assign(r,{a,runId:run.id,datasetId:run.defaultDatasetId,status:run.status});break;}
          }
        } catch {}
      }
      if(!found)throw new Error('Recovery run must belong to one of this workspace\'s Apify accounts and an uncertain Actor.');
    } else if(confirmedNotStarted) open.forEach(r=>r.status='FAILED');
    else throw new Error('Provide a matching run_id or confirm no run was started.');
    j.status='RUNNING';
    await this.put(w,'job-'+j.id,j);return {job_id:id,status:j.status,actors:this.runInfo(j)};
  }
  async readThrough(w,id) {return (await this.get(w,'read-'+id,true))?.n||0;}
  async listJobs(w) {
    const records=await this.apify.request(`/key-value-stores/${encodeURIComponent(w.storeId)}/keys?limit=1000`,w.token);
    const keys=records.data.items.filter(x=>x.key.startsWith('job-')).slice(-50);
    const jobs=[];
    // Bound fan-out to avoid overloading the seller's API.
    for(let i=0;i<keys.length;i+=5) {
      const batch=await Promise.all(keys.slice(i,i+5).map(k=>this.get(w,k.key)));
      jobs.push(...batch.filter(j=>j.owner===w.owner).map(j=>({job_id:j.id,status:j.status,actors:(j.runs||[{actor:j.actor}]).map(r=>r.actor),username:j.username,buyer_need:j.query,created_at:j.createdAt})));
    }
    jobs.sort((a,b)=>b.created_at.localeCompare(a.created_at));
    return {jobs,truncated:!!records.data.isTruncated||records.data.items.filter(x=>x.key.startsWith('job-')).length>50,note:'Bounded history view. Keep job IDs to resume older research.'};
  }
  async evidenceErrors(w,evidence) {
    const errors=[],cache=new Map();
    for(const e of evidence) {
      try {
        if(!cache.has(e.job_id))cache.set(e.job_id,await this.job(w,e.job_id));
        if(!rowsFor(cache.get(e.job_id)).some(r=>r.source_url===fiverrUrl(e.source_url)))errors.push(`Evidence URL not collected in job ${e.job_id}.`);
      }catch {errors.push(`Evidence job ${e.job_id} unavailable in this workspace.`);}
    }
    return errors;
  }
}
