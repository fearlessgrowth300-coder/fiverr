import { randomUUID } from 'node:crypto';
import { ACTORS, actorInput } from './apify.js';
import { hash } from './storage.js';
import { normalize, viewJob, rowsFor } from './normalize.js';

const terminal = new Set(['SUCCEEDED','FAILED','TIMED-OUT','ABORTED']);
export class Research {
  constructor(store, apify, { maxCharge = 0.5, maxDaily = 10, maxConcurrent = 2 } = {}) {
    Object.assign(this, { store, apify, maxCharge, maxDaily, maxConcurrent });
  }
  async request(workspace, mode, args, view) {
    if (args.job_id) {
      const j = this.store.get(args.job_id, workspace.owner);
      if (mode === 'seller') {
        if (j.username !== args.username && !rowsFor(j,args.username).length) throw new Error('This job contains no evidence for the requested seller.');
      } else if (j.mode !== mode) throw new Error('Job does not match the requested research scope.');
      return this.result(j, view, args);
    }
    if (!workspace.token) throw new Error('Set APIFY_TOKEN locally on the server before live research.');
    const adapter = args.adapter || 'memo23';
    const input = actorInput(adapter, mode, args);
    const fingerprint = hash(JSON.stringify([workspace.owner, adapter, input]));
    const jobs = Object.values(this.store.state.jobs);
    const existing = jobs.find(j => j.fingerprint === fingerprint && Date.now() - Date.parse(j.createdAt) < 3600_000 && !['FAILED','ABORTED','TIMED-OUT'].includes(j.status));
    if (existing) return this.result(existing, view, args);
    const key = `${workspace.owner}:${new Date().toISOString().slice(0,10)}`;
    if ((this.store.state.daily[key] || 0) >= this.maxDaily) throw new Error('Daily run limit reached. Read existing jobs or change the server limit locally.');
    if (jobs.filter(j => j.owner === workspace.owner && !terminal.has(j.status)).length >= this.maxConcurrent) throw new Error('Concurrent run limit reached. Poll existing jobs before starting another.');
    const j = { id: randomUUID(), owner: workspace.owner, fingerprint, mode, username: args.username, query: mode === 'search' ? args.buyer_need : undefined, adapter, actor: ACTORS[adapter].id, status: 'STARTING', createdAt: new Date().toISOString(), limit: args.limit };
    this.store.state.jobs[j.id] = j;
    this.store.state.daily[key] = (this.store.state.daily[key] || 0) + 1;
    this.store.save();
    try {
      const run = await this.apify.start(adapter, input, workspace.token, this.maxCharge);
      j.runId = run.id; j.datasetId = run.defaultDatasetId; j.status = run.status;
      this.store.save();
      return this.result(j, view, args);
    } catch (e) {
      j.status = 'START_UNCERTAIN'; this.store.save();
      throw new Error(`${e.message} Job ${j.id} is reserved to prevent duplicate billing. Use recover_research_job with the run ID from Apify Console, or mark confirmed_not_started only after checking.`);
    }
  }
  result(j, view, args = {}) {
    if (!j.rows) return { job_id: j.id, status: j.status, actor: j.actor, next_step: 'Call get_research_job with this job_id. Once data is available, repeat the original tool with job_id, username when applicable, offset and limit. Do not start a new run to poll.' };
    return viewJob(j, view, args.username, args.offset || 0, args.limit || 10);
  }
  async poll(workspace, id) {
    const j = this.store.get(id, workspace.owner);
    if (j.rows) return { ...this.result(j, 'gigs'), research_complete: j.status === 'SUCCEEDED' };
    if (!j.runId) return this.result(j, 'gigs');
    const run = await this.apify.poll(j.runId, workspace.token);
    j.status = run.status;
    j.datasetId = run.defaultDatasetId || j.datasetId;
    if (terminal.has(j.status)) {
      const items = [];
      if (j.datasetId) {
        for (let offset = 0; offset < j.limit; offset += 100) {
          const page = await this.apify.items(j.datasetId, workspace.token, offset, Math.min(100,j.limit-offset));
          items.push(...page);
          if (page.length < Math.min(100,j.limit-offset)) break;
        }
      }
      j.rows = items.map(normalize);
      j.collectedAt = new Date().toISOString();
      j.partial = j.status !== 'SUCCEEDED';
    }
    this.store.save();
    return { ...this.result(j, 'gigs'), partial_results: j.partial || false, research_complete: j.status === 'SUCCEEDED' };
  }
  async recover(workspace, id, runId, confirmedNotStarted) {
    const j = this.store.get(id, workspace.owner);
    if (!['STARTING','START_UNCERTAIN'].includes(j.status)) throw new Error('Only uncertain start jobs can be recovered.');
    if (runId) {
      const run = await this.apify.poll(runId, workspace.token);
      // Verify this token can access the run and that it belongs to the selected Actor.
      const meta = await this.apify.request(`/acts/${j.actor.replace('/', '~')}`, workspace.token);
      if (run.actId !== meta.data.id) throw new Error('Recovery run belongs to a different Actor.');
      j.runId = run.id; j.datasetId = run.defaultDatasetId; j.status = run.status;
    } else if (confirmedNotStarted) j.status = 'FAILED';
    else throw new Error('Provide run_id or confirmed_not_started after checking Apify Console.');
    this.store.save(); return { job_id: id, status: j.status };
  }
  evidenceErrors(workspace, evidence) {
    const errors = [];
    for (const e of evidence) {
      try {
        const j = this.store.get(e.job_id, workspace.owner);
        if (!j.rows || !rowsFor(j).some(r => r.source_url === e.source_url)) errors.push(`Evidence source was not collected in job ${e.job_id}.`);
      } catch { errors.push(`Evidence job ${e.job_id} is unavailable in this workspace.`); }
    }
    return errors;
  }
}
