import { randomUUID } from 'node:crypto';
import { ACTORS, actorInput } from './apify.js';
import { normalize, viewJob, rowsFor } from './normalize.js';
import { hash } from './storage.js';

const terminal=new Set(['SUCCEEDED','FAILED','ABORTED','TIMED-OUT']);
export class HostedResearch {
  constructor(apify,{maxCharge=0.5}={}) {this.apify=apify;this.maxCharge=maxCharge;}
  path(w,key) {return `/key-value-stores/${encodeURIComponent(w.storeId)}/records/${encodeURIComponent(key)}`;}
  async get(w,key,optional=false) {
    try {return await this.apify.request(this.path(w,key),w.token);}
    catch(e) {if(optional&&e.status===404)return null;throw e;}
  }
  async put(w,key,data) {await this.apify.request(this.path(w,key),w.token,{method:'PUT',body:JSON.stringify(data)});}
  async job(w,id) {
    const j=await this.get(w,'job-'+id);
    if(!j || j.owner!==w.owner) throw new Error('Research job not found in this workspace.');
    return j;
  }
  result(j,view,args={}) {
    if(!j.rows) return {job_id:j.id,status:j.status,actor:j.actor,next_step:'Poll get_research_job with this job_id. Do not start a new run to poll.'};
    return {...viewJob(j,view,args.username,args.offset||0,args.limit||10),partial_results:j.status!=='SUCCEEDED'};
  }
  async request(w,mode,args,view) {
    if(args.job_id) {
      const j=await this.job(w,args.job_id);
      if(mode==='seller' ? j.username!==args.username&&!rowsFor(j,args.username).length : j.mode!==mode) throw new Error('Job does not match requested seller or research scope.');
      return this.result(j,view,args);
    }
    const adapter=args.adapter||'memo23',input=actorInput(adapter,mode,args);
    // Inspect BEFORE reserving/starting a paid job. Catalog inspection starts no run.
    if(!this.apify.schemaCache.has(adapter))await this.apify.inspect(adapter);
    const fingerprint=hash(JSON.stringify([adapter,input]));
    const cached=await this.get(w,'query-'+fingerprint,true);
    if(cached && Date.now()-Date.parse(cached.createdAt)<3600000) {
      const j=await this.job(w,cached.id);
      if(!['FAILED','TIMED-OUT','ABORTED'].includes(j.status)) return this.result(j,view,args);
    }
    const j={id:randomUUID(),owner:w.owner,mode,username:args.username,query:mode==='search'?args.buyer_need:undefined,adapter,actor:ACTORS[adapter].id,status:'STARTING',createdAt:new Date().toISOString(),limit:Math.min(args.limit||10,50)};
    await this.put(w,'job-'+j.id,j);
    await this.put(w,'query-'+fingerprint,{id:j.id,createdAt:j.createdAt});
    try {
      const run=await this.apify.start(adapter,input,w.token,this.maxCharge);
      j.runId=run.id;j.datasetId=run.defaultDatasetId;j.status=run.status;
      await this.put(w,'job-'+j.id,j);
      return this.result(j,view,args);
    } catch(e) {
      j.status='START_UNCERTAIN';
      try{await this.put(w,'job-'+j.id,j);}catch{}
      throw new Error(`Research job ${j.id} has an uncertain start. Check Apify Console before retrying; use recover_research_job to avoid duplicate charges.`);
    }
  }
  async poll(w,id) {
    const j=await this.job(w,id);
    if(j.rows)return {...this.result(j,'gigs'),research_complete:j.status==='SUCCEEDED'};
    if(!j.runId)return this.result(j,'gigs');
    const run=await this.apify.poll(j.runId,w.token);
    if(run.userId && run.userId!==w.userId) throw new Error('Run ownership mismatch.');
    j.status=run.status;j.datasetId=run.defaultDatasetId||j.datasetId;
    if(terminal.has(j.status)) {
      const rows=j.datasetId?await this.apify.items(j.datasetId,w.token,0,j.limit):[];
      j.rows=rows.map(normalize);j.collectedAt=new Date().toISOString();
    }
    await this.put(w,'job-'+j.id,j);
    return {...this.result(j,'gigs'),research_complete:j.status==='SUCCEEDED'};
  }
  async recover(w,id,runId,confirmedNotStarted) {
    const j=await this.job(w,id);
    if(!['STARTING','START_UNCERTAIN'].includes(j.status))throw new Error('Only uncertain starts can be recovered.');
    if(runId) {
      const run=await this.apify.poll(runId,w.token);
      const actor=await this.apify.request(`/acts/${j.actor.replace('/','~')}`,w.token);
      if(run.actId!==actor.data.id || run.userId!==w.userId)throw new Error('Recovery run must belong to this account and the same Actor.');
      j.runId=run.id;j.datasetId=run.defaultDatasetId;j.status=run.status;
    } else if(confirmedNotStarted)j.status='FAILED';
    else throw new Error('Provide a matching run_id or confirm no run was started.');
    await this.put(w,'job-'+j.id,j);return {job_id:id,status:j.status};
  }
  async listJobs(w) {
    const records=await this.apify.request(`/key-value-stores/${encodeURIComponent(w.storeId)}/keys?limit=1000`,w.token);
    const keys=records.data.items.filter(x=>x.key.startsWith('job-')).slice(-50);
    const jobs=[];
    // Bound fan-out to avoid overloading the seller's API.
    for(let i=0;i<keys.length;i+=5) {
      const batch=await Promise.all(keys.slice(i,i+5).map(k=>this.get(w,k.key)));
      jobs.push(...batch.filter(j=>j.owner===w.owner).map(j=>({job_id:j.id,status:j.status,actor:j.actor,username:j.username,buyer_need:j.query,created_at:j.createdAt})));
    }
    jobs.sort((a,b)=>b.created_at.localeCompare(a.created_at));
    return {jobs,truncated:!!records.data.isTruncated||records.data.items.filter(x=>x.key.startsWith('job-')).length>50,note:'Bounded history view. Keep job IDs to resume older research.'};
  }
  async evidenceErrors(w,evidence) {
    const errors=[],cache=new Map();
    for(const e of evidence) {
      try {
        if(!cache.has(e.job_id))cache.set(e.job_id,await this.job(w,e.job_id));
        if(!rowsFor(cache.get(e.job_id)).some(r=>r.source_url===e.source_url))errors.push(`Evidence URL not collected in job ${e.job_id}.`);
      }catch {errors.push(`Evidence job ${e.job_id} unavailable in this workspace.`);}
    }
    return errors;
  }
}
