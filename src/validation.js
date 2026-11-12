import { z } from 'zod';
export const count = (s) => [...s].length;
const text = z.string().trim().min(1).max(6000);
const list = z.array(text).min(1).max(30);
const tier = z.object({ name: text, description: text, price_usd: z.number().min(5), delivery_days: z.number().int().min(1), revisions: z.number().int().min(1), deliverables: list, exclusions: z.array(text).max(20) });
export const gigSchema = z.object({
  profile: z.object({ about: text, skills: list, facts_to_confirm: z.array(text).max(30) }),
  target_search: text.max(60).describe('TITLE FORMULA part 1: the low-competition + high-demand buyer search this gig should rank for (from compare_keywords), e.g. "ai music video for birthday".'),
  traffic_terms: z.array(text.max(40)).max(4).default([]).describe('TITLE FORMULA part 2: 1-4 high-traffic, algorithm-favoured related terms combined into the title (most used in page-1 titles/tags and Fiverr search tags, e.g. "music video", "lyric video").'),
  search_job_id: z.string().uuid().optional().describe('find_freelancers job_id, to score the draft against that market.'),
  service_options: z.array(z.object({ option: text, values: z.array(text).min(1) })).max(15).default([]).describe('Fiverr metadata boxes to tick (style, platform, file format...). Buyers filter on these.'),
  title: text,
  category: text, subcategory: text, category_verified: z.boolean(),
  tags: z.array(text).max(20),
  packages: z.object({ basic: tier, standard: tier, premium: tier }),
  pricing_rationale: text,
  description: text,
  faq: z.array(z.object({ question: text, answer: text })).min(1).max(10),
  images: z.array(z.object({ headline: text, supporting_text: text, layout: text, visual_concept: text, buyer_relevance: text, thumbnail_check: text })).min(1).max(3),
  requirements: z.array(z.object({ question: text, required: z.boolean(), response_type: z.enum(['free_text', 'attachment', 'multiple_choice']), options: z.array(text).optional() })).min(1).max(20),
  buyer_hypothesis: text,
  buyer_check: z.object({ real_problem: text, seller_can_fix_it: text, contact_now: text }).describe('Read the finished gig AS the buyer: Is this my real problem (in my words)? Can this seller clearly fix it? Would I message/order right now, and why? Any "no" means revise the gig first.'),
  evidence: z.array(z.object({ job_id: z.string().uuid(), source_url: z.string().url(), observation: text })).max(30),
  limitations: list,
  next_question: text,
});

export function validateGig(input) {
  const parsed = gigSchema.safeParse(input);
  if (!parsed.success) return { valid: false, errors: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) };
  const g = parsed.data, errors = [], warnings = [];
  const counts = { title: count(g.title), title_field: count(g.title.replace(/^I will /, '')), description: count(g.description), tags: g.tags.map(count) };
  if (counts.title_field !== 79) errors.push(`Title after 'I will ' must be exactly 79 characters (the Fiverr title box); got ${counts.title_field}.`);
  if (!g.title.startsWith('I will ')) errors.push('Full title must start with I will followed by a space.');
  const tw = new Set(g.title.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []), missing = (g.target_search.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(x => !tw.has(x) && !tw.has(x + 's'));
  if (missing.length) errors.push(`Title is the strongest ranking signal: include every word of the target search "${g.target_search}" (missing: ${missing.join(', ')}).`);
  const words = s => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  if (!g.traffic_terms.length) errors.push('Title formula: low competition + high demand + high-traffic related terms. Add traffic_terms: 1-4 high-traffic, algorithm-favoured related terms and combine them into the title with target_search.');
  for (const t of g.traffic_terms) { const m = words(t).filter(x => !tw.has(x) && !tw.has(x + 's')); if (m.length) errors.push(`Title must combine the high-traffic term "${t}" (missing: ${m.join(', ')}).`); }
  if (!g.tags.some(t => t.toLowerCase().includes(g.target_search.toLowerCase()))) warnings.push('No tag contains the exact target search phrase.');
  if (/[&/"+\r\n]/.test(g.title)) errors.push('Title contains unsupported punctuation or a newline.');
  if (counts.description !== 1200) errors.push(`Description must be exactly 1200 characters; got ${counts.description}.`);
  if (g.tags.length !== 5 || new Set(g.tags.map(t => t.toLowerCase())).size !== 5) errors.push('Provide exactly five distinct tags.');
  g.tags.forEach((t, i) => { if (count(t) > 20 || !/^[\p{L}\p{N} ]+$/u.test(t)) errors.push(`Tag ${i + 1} must be alphanumeric words/spaces and at most 20 characters.`); });
  if (!(g.packages.basic.price_usd < g.packages.standard.price_usd && g.packages.standard.price_usd < g.packages.premium.price_usd)) errors.push('Package prices must increase from Basic to Standard to Premium.');
  for (const [name, p] of Object.entries(g.packages)) {
    if (count(p.description) > 100) errors.push(`${name} package description exceeds the conservative 100-character limit.`);
  }
  for (const r of g.requirements) if (r.response_type === 'multiple_choice' && (!r.options || r.options.length < 2)) errors.push('Multiple-choice requirements need at least two options.');
  if (count(g.profile.about) > 600) errors.push('Profile about exceeds the conservative 600-character limit.');
  if (!g.category_verified) warnings.push('Category/subcategory must be confirmed in the current Fiverr editor.');
  if (!g.evidence.length) warnings.push('No live evidence attached; present as an unresearched draft.');
  warnings.push('Validation checks structure and lengths, not truthfulness, category eligibility, conversion or Fiverr approval.');
  return { valid: errors.length === 0, errors, warnings, counts, normalized: g };
}

export function renderGig(g) {
  const lines = ['# Fiverr gig package', '', '## Profile', g.profile.about, '', `Skills: ${g.profile.skills.join(', ')}`, '', 'Confirm: ' + (g.profile.facts_to_confirm.join('; ') || 'No unresolved profile facts supplied.'), '', '## Title', g.title, '', `Paste after Fiverr's I will prefix: ${g.title.slice(7)}`, '', `Category: ${g.category} > ${g.subcategory}${g.category_verified ? '' : ' (confirm in editor)'}`, '', ...(g.service_options.length ? ['Service options to tick: ' + g.service_options.map(o => `${o.option}: ${o.values.join(', ')}`).join(' | '), ''] : []), `Title formula: ${g.target_search} (low competition, high demand) + ${g.traffic_terms.join(', ')} (high traffic)`, '', `Tags: ${g.tags.join(' | ')}`, '', '## Packages'];
  for (const [key, p] of Object.entries(g.packages)) lines.push('', `### ${key.toUpperCase()} — ${p.name} — $${p.price_usd} USD`, p.description, '', `${p.delivery_days} days; ${p.revisions} revisions`, '', ...p.deliverables.map(x => `- ${x}`), '', `Excludes: ${p.exclusions.join('; ') || 'None specified'}`);
  lines.push('', `Pricing rationale: ${g.pricing_rationale}`, '', '## Description', g.description, '', '## FAQ');
  for (const f of g.faq) lines.push('', `**${f.question}**`, f.answer);
  lines.push('', '## Image briefs — 1280 x 769 px');
  g.images.forEach((im, i) => lines.push('', `### Image ${i + 1}: ${im.headline}`, im.supporting_text, '', `Layout: ${im.layout}`, `Visual: ${im.visual_concept}`, `Buyer relevance: ${im.buyer_relevance}`, `Thumbnail check: ${im.thumbnail_check}`));
  lines.push('', '## Buyer requirements', ...g.requirements.map(r => `- ${r.question} (${r.required ? 'Required' : 'Optional'}; ${r.response_type})${r.options ? ': ' + r.options.join(' / ') : ''}`), '', '## Buyer check', `Is this my real problem? ${g.buyer_check.real_problem}`, `Can this seller fix it? ${g.buyer_check.seller_can_fix_it}`, `Would I contact them now? ${g.buyer_check.contact_now}`, '', '## Research', `Buyer hypothesis: ${g.buyer_hypothesis}`, '', ...g.evidence.map(e => `- ${e.observation} — ${e.source_url} (research ${e.job_id})`), '', 'Limitations:', ...g.limitations.map(x => `- ${x}`), '', g.next_question);
  return lines.join('\n');
}
