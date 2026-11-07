import { z } from 'zod';
export const count = (s) => [...s].length;
const text = z.string().trim().min(1).max(6000);
const list = z.array(text).min(1).max(30);
const tier = z.object({ name: text, description: text, price_usd: z.number().min(5), delivery_days: z.number().int().min(1), revisions: z.number().int().min(1), deliverables: list, exclusions: z.array(text).max(20) });
export const gigSchema = z.object({
  profile: z.object({ about: text, skills: list, facts_to_confirm: z.array(text).max(30) }),
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
  evidence: z.array(z.object({ job_id: z.string().uuid(), source_url: z.string().url(), observation: text })).max(30),
  limitations: list,
  next_question: text,
});

export function validateGig(input) {
  const parsed = gigSchema.safeParse(input);
  if (!parsed.success) return { valid: false, errors: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) };
  const g = parsed.data, errors = [], warnings = [];
  const counts = { title: count(g.title), title_field: count(g.title.replace(/^I will /, '')), description: count(g.description), tags: g.tags.map(count) };
  if (counts.title !== 78) errors.push(`Title must be exactly 78 characters including I will; got ${counts.title}.`);
  if (!g.title.startsWith('I will ')) errors.push('Full title must start with I will followed by a space.');
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
  const lines = ['# Fiverr gig package', '', '## Profile', g.profile.about, '', `Skills: ${g.profile.skills.join(', ')}`, '', 'Confirm: ' + (g.profile.facts_to_confirm.join('; ') || 'No unresolved profile facts supplied.'), '', '## Title', g.title, '', `Paste after Fiverr's I will prefix: ${g.title.slice(7)}`, '', `Category: ${g.category} > ${g.subcategory}${g.category_verified ? '' : ' (confirm in editor)'}`, '', `Tags: ${g.tags.join(' | ')}`, '', '## Packages'];
  for (const [key, p] of Object.entries(g.packages)) lines.push('', `### ${key.toUpperCase()} — ${p.name} — $${p.price_usd} USD`, p.description, '', `${p.delivery_days} days; ${p.revisions} revisions`, '', ...p.deliverables.map(x => `- ${x}`), '', `Excludes: ${p.exclusions.join('; ') || 'None specified'}`);
  lines.push('', `Pricing rationale: ${g.pricing_rationale}`, '', '## Description', g.description, '', '## FAQ');
  for (const f of g.faq) lines.push('', `**${f.question}**`, f.answer);
  lines.push('', '## Image briefs — 1280 x 769 px');
  g.images.forEach((im, i) => lines.push('', `### Image ${i + 1}: ${im.headline}`, im.supporting_text, '', `Layout: ${im.layout}`, `Visual: ${im.visual_concept}`, `Buyer relevance: ${im.buyer_relevance}`, `Thumbnail check: ${im.thumbnail_check}`));
  lines.push('', '## Buyer requirements', ...g.requirements.map(r => `- ${r.question} (${r.required ? 'Required' : 'Optional'}; ${r.response_type})${r.options ? ': ' + r.options.join(' / ') : ''}`), '', '## Research', `Buyer hypothesis: ${g.buyer_hypothesis}`, '', ...g.evidence.map(e => `- ${e.observation} — ${e.source_url} (research ${e.job_id})`), '', 'Limitations:', ...g.limitations.map(x => `- ${x}`), '', g.next_question);
  return lines.join('\n');
}
