import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { authorize } from './storage.js';
import { ACTORS } from './apify.js';
import { fiverrUrl } from './normalize.js';
import { gigSchema, validateGig, renderGig } from './validation.js';
import { WORKFLOW, RULES } from './workflow.js';

const workspace_key = z.string().min(24).max(2048).describe('Your private workspace key from the Fiverr Gig Studio website, NOT a raw Apify token.');
const username = z.string().regex(/^[A-Za-z0-9_]{2,60}$/).describe('Exact known Fiverr username. Discover sellers with find_freelancers first.');
const adapter = z.enum(['memo23','logiover','dionysus']).default('memo23');
const pagination = { job_id: z.string().uuid().optional(), offset: z.number().int().min(0).max(10000).default(0), limit: z.number().int().min(1).max(50).default(10) };
const outputSchema = { result: z.record(z.string(), z.unknown()) };
const result = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: { result: data } });
export function createServer({ workspaces, research, apify, authenticate }) {
  const server = new McpServer({ name: 'fiverr-gig-studio', version: '0.1.0' }, { instructions: WORKFLOW });
  const tool = (name, description, inputSchema, handler, { paid = false, external = false } = {}) => server.registerTool(name, {
    title: name.split('_').join(' '), description, inputSchema, outputSchema,
    annotations: { readOnlyHint: !paid, destructiveHint: false, idempotentHint: !paid, openWorldHint: external },
  }, async args => {
    try { return result(await handler(args)); }
    catch (e) { return { isError: true, content: [{ type: 'text', text: e.message.replace(/apify_api_[\w-]+/g, '[REDACTED]') }] }; }
  });
  const auth = args => authenticate ? authenticate(args.workspace_key) : authorize(args.workspace_key, workspaces);

  tool('prepare_gig_brief', 'Start here for creating a Fiverr gig, seller profile about text or skills. Returns the buyer-perspective workflow and complete output requirements. ChatGPT/Claude writes the draft after research.', {
    service: z.string().trim().min(3).max(500), seller_facts: z.array(z.string().max(300)).max(20).default([]), known_constraints: z.array(z.string().max(300)).max(20).default([]),
  }, async args => ({ brief: args, buyer_perspective_question: 'What outcome does a buyer of this service need, and what would make this offer a clear fit?', instructions: WORKFLOW, rules: RULES, next_step: 'Form a concise buyer-language search from this service. Ask the user only if the service itself is ambiguous; leave unsupported constraints unspecified.' }));

  tool('discover_research_actors', 'Discover Fiverr-related Apify actors for a missing research aspect. Returns catalog metadata only; does not run or bill an Actor. Only inspected adapters can be executed by this server.', {
    workspace_key, aspect: z.enum(['Fiverr','Fiverr reviews','Fiverr gigs','Fiverr profiles']).default('Fiverr'),
  }, async args => { auth(args); return { actors: await apify.discover(args.aspect), executable_adapters: ACTORS, note: 'Catalog claims are unverified. Inspect input schema and capabilities before execution. Choose relevant actors; do not run the entire store.' }; }, { external: true });

  tool('inspect_research_actor', 'Read the current schema, documented coverage and limitations for an executable Apify adapter. No paid run.', { workspace_key, adapter }, async args => { auth(args); return apify.inspect(args.adapter); }, { external: true });

  tool('find_freelancers', 'Discover and compare Fiverr sellers/gigs for gig creation research or an explicit hiring search. Use only the buyer-worded need for THIS service. Do not send the conversation. Do not invent budget, skills or deadlines from an ambiguous problem. Starts a bounded paid Apify run, or reads a prior job snapshot.', {
    workspace_key, buyer_need: z.string().trim().min(3).max(300), adapter, ...pagination,
  }, args => research.request(auth(args), 'search', args, 'gigs'), { paid: true, external: true });

  const sellerTools = [
    ['get_freelancer_overview','overview', 'Combined public bio, notable clients when exposed, services, prices, review samples and summaries. Latest-review ordering is not guaranteed.'],
    ['get_seller_profile','profile', 'Check a named seller background, location, languages and skills. Not a discovery tool.'],
    ['get_seller_reviews_summary','summary', 'Retrieve seller aggregate rating and review count. Never substitutes a gig rating or an average of gigs. Use list_seller_reviews for review text.'],
    ['list_seller_gigs','gigs', 'List public-page gigs and prices from a known seller. Continue snapshot pages until has_next_page=false. Unknown publication status is disclosed; no private or draft gigs are requested. The snapshot may not contain every Fiverr gig.'],
    ['list_seller_reviews','reviews', 'Read actual review objects collected on a named seller gig pages, paginated within the snapshot. Summary strings are labeled separately. Does not promise all reviews or newest-first ordering. If empty, research individual gig URLs with get_gig_details.'],
  ];
  for (const [name, view, description] of sellerTools) tool(name, description + ' Reuse job_id to avoid repeated runs.', { workspace_key, username, adapter, ...pagination }, args => research.request(auth(args), 'seller', args, view), { paid: true, external: true });

  tool('get_gig_details', 'Research specific public Fiverr gig URLs: descriptions, packages, prices, tags, images, FAQ and review samples. Useful after seller discovery. Never copies competitors into the draft.', {
    workspace_key, urls: z.array(z.string().url().refine(v => !!fiverrUrl(v) && new URL(v).pathname.split('/').filter(Boolean).length === 2, 'Must be a public HTTPS Fiverr gig URL')).min(1).max(5), adapter, ...pagination,
  }, args => research.request(auth(args), 'gig', args, 'gigs'), { paid: true, external: true });

  tool('get_research_job', 'Poll an existing research job and collect its results when finished. Does not start another paid run. Failed runs can contain explicitly partial results.', { workspace_key, job_id: z.string().uuid() }, args => research.poll(auth(args), args.job_id), { external: true });
  tool('list_research_jobs', 'List this workspace research jobs so pending work can be resumed after a restart.', { workspace_key }, async args => {
    const w = auth(args);
    if (research.listJobs) return research.listJobs(w);
    return { jobs: Object.values(research.store.state.jobs).filter(j => j.owner === w.owner).slice(-50).map(j => ({ job_id:j.id, status:j.status, actor:j.actor, mode:j.mode, username:j.username, buyer_need:j.query, created_at:j.createdAt })) };
  });
  tool('recover_research_job', 'Recover an uncertain Actor start after a network failure. First inspect Apify Console. Supply the corresponding run ID, or confirm that no run was started. Prevents accidental duplicate billing.', { workspace_key, job_id:z.string().uuid(), run_id:z.string().regex(/^[A-Za-z0-9]+$/).optional(), confirmed_not_started:z.boolean().default(false) }, args => research.recover(auth(args),args.job_id,args.run_id,args.confirmed_not_started), { external:true });

  tool('validate_gig_package', 'Validate the complete draft: exactly 78 title characters INCLUDING I will, exactly 5 tags of at most 20 characters, exactly 1200 description characters, packages, FAQ, images, requirements and evidence provenance. Revise until valid.', { workspace_key, gig: gigSchema }, async args => {
    const w = auth(args), v = validateGig(args.gig);
    if (v.normalized) v.errors.push(...await research.evidenceErrors(w,v.normalized.evidence));
    v.valid = !v.errors.length;
    const { normalized, ...report } = v; return report;
  });
  tool('finalize_gig_package', 'Return the finished Fiverr gig/profile package as Markdown after successful validation. Does not publish to Fiverr. The host AI must compose the package and verify factual claims first.', { workspace_key, gig: gigSchema }, async args => {
    const w = auth(args), v = validateGig(args.gig);
    if (v.normalized) v.errors.push(...await research.evidenceErrors(w,v.normalized.evidence));
    if (v.errors.length) return { valid:false, errors:v.errors, counts:v.counts };
    return { valid:true, counts:v.counts, warnings:v.warnings, markdown:renderGig(v.normalized) };
  });
  server.registerPrompt('create_fiverr_gig', { description:'Research competitors and draft a complete buyer-focused Fiverr gig.', argsSchema:{ service:z.string() } }, async ({ service }) => ({ messages:[{role:'user',content:{type:'text',text:`Create my Fiverr gig for this service: ${service}\n\n${WORKFLOW}`}}] }));
  server.registerResource('gig-workflow','fiverr-gig://workflow',{ description:'Buyer-focused drafting workflow and field requirements',mimeType:'text/plain' },async()=>({contents:[{uri:'fiverr-gig://workflow',mimeType:'text/plain',text:WORKFLOW}]}));
  return server;
}
