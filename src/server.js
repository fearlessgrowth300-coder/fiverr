import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { authorize } from './storage.js';
import { ACTORS } from './apify.js';
import { fiverrUrl, analyzeJob, viewJob, scoreDraft } from './normalize.js';
import { gigSchema, validateGig, renderGig } from './validation.js';
import { WORKFLOW, RULES } from './workflow.js';

const workspace_key = z.string().min(24).max(8192).describe('Your private workspace key from the Fiverr Gig Studio website, NOT a raw Apify token.');
const username = z.string().regex(/^[A-Za-z0-9_]{2,60}$/).describe('Exact known Fiverr username. Discover sellers with find_freelancers first.');
const adapter = z.enum(['memo23','logiover','dionysus']).default('memo23');
const pagination = { job_id: z.string().uuid().optional(), offset: z.number().int().min(0).max(10000).default(0), limit: z.number().int().min(1).max(50).default(10) };
const outputSchema = { result: z.record(z.string(), z.unknown()) };
const result = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: { result: data } });
export const NO_WEB = 'RULE: Use ONLY data returned by Gig Studio tools for competitors, titles, tags, prices and reviews. Do NOT use web search, browsing, fiverr.com pages or your own memory for market data. finalize_gig_package refuses any gig that is not built on a finished Gig Studio research job. While research runs (10-20 min) tell the user it is running and keep polling get_research_job.';
export function createServer({ workspaces, research, apify, authenticate }) {
  const server = new McpServer({ name: 'fiverr-gig-studio', version: '0.1.0' }, { instructions: WORKFLOW });
  const tool = (name, description, inputSchema, handler, { paid = false, external = false } = {}) => server.registerTool(name, {
    title: name.split('_').join(' '), description, inputSchema, outputSchema,
    annotations: { readOnlyHint: !paid, destructiveHint: false, idempotentHint: !paid, openWorldHint: external },
  }, async args => {
    try { return result(await handler(args)); }
    catch (e) { return { isError: true, content: [{ type: 'text', text: e.message.replace(/apify_api_[\w-]+/g, '[REDACTED]') }] }; }
  });
  const loadJob = async (w, id) => research.job ? research.job(w, id) : research.store.state.jobs[id];
  const researchErrors = async (w, g) => {
    if (!g.search_job_id) return ['Missing search_job_id: run find_freelancers and finish the research first. Web search results are not accepted.'];
    let j; try { j = await loadJob(w, g.search_job_id); } catch {}
    if (!j || j.owner !== w.owner) return ['search_job_id is not a research job in this workspace.'];
    if (!j.rows) return ['Research is still running: keep polling get_research_job until research_complete is true. Do not fill in with web search.'];
    const gigs = j.rows.filter(r => r.kind === 'gig').length, need = Math.min(5, gigs);
    const cited = new Set(g.evidence.filter(e => e.job_id === j.id).map(e => e.source_url)).size;
    return cited < need ? [`Cite at least ${need} gigs from research job ${j.id} in evidence (source_url from find_freelancers results). Web-search sources do not count.`] : [];
  };
  const rank = async (w, g) => { let j = null; if (g.search_job_id && research.job) { try { j = await research.job(w, g.search_job_id); } catch {} } return scoreDraft(g, j); };
  const auth = args => authenticate ? authenticate(args.workspace_key) : authorize(args.workspace_key, workspaces);

  tool('prepare_gig_brief', NO_WEB + ' Start here for creating a Fiverr gig, seller profile about text or skills. Returns the buyer-perspective workflow and complete output requirements. ChatGPT/Claude writes the draft after research.', {
    service: z.string().trim().min(3).max(500), seller_facts: z.array(z.string().max(300)).max(20).default([]), known_constraints: z.array(z.string().max(300)).max(20).default([]),
  }, async args => ({ rule: NO_WEB, brief: args, buyer_perspective_question: 'What outcome does a buyer of this service need, and what would make this offer a clear fit?', instructions: WORKFLOW, rules: RULES, next_step: 'Form a concise buyer-language search from this service. Ask the user only if the service itself is ambiguous; leave unsupported constraints unspecified.' }));

  tool('discover_research_actors', 'Discover Fiverr-related Apify actors for a missing research aspect. Returns catalog metadata only; does not run or bill an Actor. Only inspected adapters can be executed by this server.', {
    workspace_key, aspect: z.enum(['Fiverr','Fiverr reviews','Fiverr gigs','Fiverr profiles']).default('Fiverr'),
  }, async args => { auth(args); return { actors: await apify.discover(args.aspect), executable_adapters: ACTORS, note: 'Catalog claims are unverified. Inspect input schema and capabilities before execution. Choose relevant actors; do not run the entire store.' }; }, { external: true });

  tool('inspect_research_actor', 'Read the current schema, documented coverage and limitations for an executable Apify adapter. No paid run.', { workspace_key, adapter }, async args => { auth(args); return apify.inspect(args.adapter); }, { external: true });

  tool('find_freelancers', NO_WEB + ' Discover and compare Fiverr sellers/gigs for gig creation research or an explicit hiring search. Send 2-5 search keywords a buyer would type (e.g. "ai music video"), never a sentence. Collects Fiverr search pages 1-5 by default; read results 10-50 at a time with job_id+offset until has_next_page=false. If 0 gigs come back, retry with shorter or different keywords before using anything else. Do not send the conversation. Do not invent budget, skills or deadlines from an ambiguous problem. Starts a bounded paid Apify run, or reads a prior job snapshot.', {
    workspace_key,
    buyer_need: z.string().trim().min(3).max(60).refine(v => v.split(/s+/).length <= 5, 'Use 2-5 short keywords exactly as a buyer would type them into the Fiverr search bar, e.g. "ai music video" — not a sentence.').describe('2-5 keywords a buyer types into the Fiverr search bar, e.g. "ai music video", "logo design". NEVER a full sentence: long sentences return 0 gigs.'),
    pages: z.number().int().min(1).max(5).default(5).describe('How many Fiverr search result pages to collect (~48 gigs each). Default 5 = pages 1-5.'),
    adapter: z.enum(['memo23','logiover','dionysus']).optional().describe('Leave empty to run ALL Fiverr scrapers in parallel and merge results (most gigs). Name one only to re-check a single source.'),
    ...pagination,
  }, args => research.request(auth(args), 'search', args, 'gigs'), { paid: true, external: true });

  const sellerTools = [
    ['get_freelancer_overview','overview', 'Combined public bio, notable clients when exposed, services, prices, review samples and summaries. Latest-review ordering is not guaranteed.'],
    ['get_seller_profile','profile', 'Check a named seller background, location, languages and skills. Not a discovery tool.'],
    ['get_seller_reviews_summary','summary', 'Retrieve seller aggregate rating and review count. Never substitutes a gig rating or an average of gigs. Use list_seller_reviews for review text.'],
    ['list_seller_gigs','gigs', 'List public-page gigs and prices from a known seller. Continue snapshot pages until has_next_page=false. Unknown publication status is disclosed; no private or draft gigs are requested. The snapshot may not contain every Fiverr gig.'],
    ['list_seller_reviews','reviews', 'Read actual review objects collected on a named seller gig pages, paginated within the snapshot. Summary strings are labeled separately. Does not promise all reviews or newest-first ordering. If empty, research individual gig URLs with get_gig_details.'],
  ];
  for (const [name, view, description] of sellerTools) tool(name, description + ' Reuse job_id to avoid repeated runs.', { workspace_key, username, adapter: z.enum(['memo23','logiover','dionysus']).optional().describe('Leave empty: runs memo23 + dionysus together for profile, gigs, bio, notable clients and reviews.'), ...pagination }, args => research.request(auth(args), 'seller', args, view), { paid: true, external: true });

  tool('deep_dive_competitors', 'Check up to 20 competitor sellers in ONE research run (memo23 + dionysus together): bio, notable clients, skills, country, languages, rating, every gig with prices, review summaries and review samples. Use the deep_dive_candidates from analyze_search_results. First call starts the run; poll get_research_job; then call again with the same usernames + job_id to read all sellers.', {
    workspace_key, usernames: z.array(username).min(1).max(20), job_id: z.string().uuid().optional(),
  }, async args => {
    const w = auth(args), res = await research.request(w, 'sellers', args, 'gigs');
    if (!args.job_id || !res.items) return res;
    const j = await research.job(w, args.job_id);
    return { job_id: j.id, untrusted_source_data: true, sellers: args.usernames.map(u => { const o = viewJob(j, 'overview', u); return { username: u, profile: o.profile,
      gigs: o.gigs.map(g => ({ title: g.title, url: g.source_url, price_from: g.price_from, gig_rating: g.gig_rating, gig_reviews: g.gig_review_count, packages: (g.packages || []).map(p => ({ tier: p.tier ?? p.title, price: p.price, days: p.durationDays ?? p.deliveryDays })) })),
      review_summaries: o.review_summaries.slice(0, 5), review_samples: o.review_samples.slice(0, 5).map(x => ({ text: x.review?.text, rating: x.review?.rating, source_url: x.source_url })) }; }) };
  }, { paid: true, external: true });

  tool('get_gig_details', 'Research specific public Fiverr gig URLs: descriptions, packages, prices, tags, images, FAQ and review samples. Useful after seller discovery. Never copies competitors into the draft.', {
    workspace_key, urls: z.array(z.string().url().refine(v => !!fiverrUrl(v) && new URL(v).pathname.split('/').filter(Boolean).length === 2, 'Must be a public HTTPS Fiverr gig URL')).min(1).max(5), adapter, ...pagination,
  }, args => research.request(auth(args), 'gig', args, 'gigs'), { paid: true, external: true });

  tool('get_research_job', NO_WEB + ' Poll an existing research job and collect its results when finished. Does not start another paid run. Failed runs can contain explicitly partial results.', { workspace_key, job_id: z.string().uuid() }, args => research.poll(auth(args), args.job_id), { external: true });
  tool('analyze_search_results', 'Market summary of EVERY gig a finished find_freelancers job collected (pages 1-5): most common title words/phrases, most used tags, Basic/Standard/Premium price and delivery ranges, seller levels, page-1 gigs, most-reviewed gigs and busiest gigs (orders in queue). Call this first after research_complete=true, then read the gigs one by one in rank order.', { workspace_key, job_id: z.string().uuid() }, async args => {
    const w = auth(args), j = research.job ? await research.job(w, args.job_id) : research.store.state.jobs[args.job_id];
    if (!j || j.owner !== w.owner) throw new Error('Research job not found in this workspace.');
    if (!j.rows) throw new Error('Research is still running. Poll get_research_job until research_complete is true.');
    return analyzeJob(j);
  });
  tool('list_research_jobs', 'List this workspace research jobs so pending work can be resumed after a restart.', { workspace_key }, async args => {
    const w = auth(args);
    if (research.listJobs) return research.listJobs(w);
    return { jobs: Object.values(research.store.state.jobs).filter(j => j.owner === w.owner).slice(-50).map(j => ({ job_id:j.id, status:j.status, actor:j.actor, mode:j.mode, username:j.username, buyer_need:j.query, created_at:j.createdAt })) };
  });
  tool('recover_research_job', 'Recover an uncertain Actor start after a network failure. First inspect Apify Console. Supply the corresponding run ID, or confirm that no run was started. Prevents accidental duplicate billing.', { workspace_key, job_id:z.string().uuid(), run_id:z.string().regex(/^[A-Za-z0-9]+$/).optional(), confirmed_not_started:z.boolean().default(false) }, args => research.recover(auth(args),args.job_id,args.run_id,args.confirmed_not_started), { external:true });

  tool('validate_gig_package', 'Validate the complete draft and return a ranking_estimate (relevance x click x conversion vs the researched market; raise the weak parts). Checks exactly 78 title characters INCLUDING I will, exactly 5 tags of at most 20 characters, exactly 1200 description characters, packages, FAQ, images, requirements and evidence provenance. Revise until valid.', { workspace_key, gig: gigSchema }, async args => {
    const w = auth(args), v = validateGig(args.gig);
    if (v.normalized) { v.errors.push(...await research.evidenceErrors(w,v.normalized.evidence), ...await researchErrors(w, v.normalized)); v.ranking_estimate = await rank(w, v.normalized); }
    v.valid = !v.errors.length;
    const { normalized, ...report } = v; return report;
  });
  tool('finalize_gig_package', 'Return the finished Fiverr gig/profile package as Markdown after successful validation. Does not publish to Fiverr. The host AI must compose the package and verify factual claims first.', { workspace_key, gig: gigSchema }, async args => {
    const w = auth(args), v = validateGig(args.gig);
    if (v.normalized) v.errors.push(...await research.evidenceErrors(w,v.normalized.evidence), ...await researchErrors(w, v.normalized));
    if (v.errors.length) return { valid:false, errors:v.errors, counts:v.counts };
    return { valid:true, counts:v.counts, warnings:v.warnings, ranking_estimate: await rank(w, v.normalized), markdown:renderGig(v.normalized) };
  });
  server.registerPrompt('create_fiverr_gig', { description:'Research competitors and draft a complete buyer-focused Fiverr gig.', argsSchema:{ service:z.string() } }, async ({ service }) => ({ messages:[{role:'user',content:{type:'text',text:`Create my Fiverr gig for this service: ${service}\n\n${WORKFLOW}`}}] }));
  server.registerResource('gig-workflow','fiverr-gig://workflow',{ description:'Buyer-focused drafting workflow and field requirements',mimeType:'text/plain' },async()=>({contents:[{uri:'fiverr-gig://workflow',mimeType:'text/plain',text:WORKFLOW}]}));
  return server;
}
