// Real buyer searches: Fiverr's own search autocomplete (what buyers type on Fiverr).
// Fiverr blocks datacenter IPs (Vercel), so the server tries: direct -> seller's Apify Proxy (residential, then default) -> Google suggest.
const STOP = new Set('i will a an the and or for your you to of in with on my me by from as at be is it this that'.split(' '));
const words = s => String(s || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', Accept: '*/*' };
// DIY/tool searches (people wanting free software, not a freelancer) - only filtered on the Google fallback.
const DIY = /\b(free|generator|app|apk|download|software|tool|online|maker|editor|website|github|reddit|tutorial|how to)\b/;

async function fiverrSuggest(q, f) {
  const r = await f(`https://www.fiverr.com/search/autocomplete?query=${encodeURIComponent(q)}`, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(String(r.status));
  const t = await r.text();
  return JSON.parse(t.slice(t.indexOf('(') + 1, t.lastIndexOf(')'))).suggestions.map(s => String(s.value).toLowerCase());
}
async function googleSuggest(q, f) {
  const r = await f(`https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(q)}`, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
  return r.ok ? JSON.parse(await r.text())[1].map(s => String(s).toLowerCase()).filter(s => !DIY.test(s)) : [];
}

// fetchers: [[label, fetchFn], ...] tried in order; the first that reaches Fiverr is used for every query.
export async function buyerKeywordIdeas(seed, job, fetchers = [['direct', fetch]], fiverrTags = []) {
  seed = seed.toLowerCase().trim();
  const queries = [seed, `${seed} for`, `${seed} with`, ...'abcdefghijklmnopqrstuvwxyz'.split('').map(l => `${seed} ${l}`)];
  let source = null, run = null, viaGoogle = false;
  for (const [label, f] of fetchers) {
    try { await fiverrSuggest(seed, f); source = `Fiverr search autocomplete via ${label} (real buyer searches on Fiverr)`; run = q => fiverrSuggest(q, f).catch(() => []); break; } catch {}
  }
  if (!run) { source = 'Google suggest (Fiverr autocomplete unreachable; DIY/free-tool searches removed)'; viaGoogle = true; run = q => googleSuggest(q, fetchers[0][1]).catch(() => []); }
  const results = [];
  for (let i = 0; i < queries.length; i += 6) results.push(...await Promise.all(queries.slice(i, i + 6).map(run))); // polite: 6 at a time
  const seedWords = words(seed).filter(w => !STOP.has(w));
  const ideas = new Map();
  const add = (kw, key) => { kw = kw.trim(); if (!kw || kw.length > 60) return; const e = ideas.get(kw) || { keyword: kw, buyer_search: false, fiverr_tag_page: false, google_suggest: false, gig_tags: 0, seller_titles: 0 }; if (typeof e[key] === 'boolean') e[key] = true; else e[key]++; ideas.set(kw, e); };
  for (const items of results) for (const kw of items) add(kw, viaGoogle ? 'google_suggest' : 'buyer_search');
  for (const t of fiverrTags) add(String(t).toLowerCase().replace(/[-_]+/g, ' '), 'fiverr_tag_page');
  for (const g of (job?.rows || []).filter(r => r.kind === 'gig')) {
    new Set((g.tags || []).map(t => t.toLowerCase().trim())).forEach(t => add(t, 'gig_tags'));
    const w = words(String(g.title || '').replace(/^i will /i, ''));
    const seen = new Set();
    for (const n of [2, 3, 4]) for (let i = 0; i + n <= w.length; i++) {
      const p = w.slice(i, i + n);
      if (STOP.has(p[0]) || STOP.has(p.at(-1)) || !p.some(x => seedWords.includes(x))) continue;
      seen.add(p.join(' '));
    }
    seen.forEach(p => add(p, 'seller_titles'));
  }
  const list = [...ideas.values()].filter(e => e.buyer_search || e.fiverr_tag_page || e.google_suggest || e.gig_tags > 1 || e.seller_titles > 1)
    .map(e => ({ ...e, signal: (e.buyer_search ? 3 : 0) + (e.fiverr_tag_page ? 3 : 0) + (e.google_suggest ? 1 : 0) + Math.min(e.gig_tags, 10) * 0.5 + Math.min(e.seller_titles, 10) * 0.3 }))
    .sort((a, b) => b.signal - a.signal);
  const fiverrBacked = e => e.buyer_search || e.fiverr_tag_page || (e.google_suggest && (e.gig_tags > 0 || e.seller_titles > 0));
  return {
    seed, buyer_search_source: source,
    buyer_searches: list.filter(fiverrBacked).slice(0, 80),
    niche_down: list.filter(e => fiverrBacked(e) && e.keyword !== seed && words(e.keyword).some(x => seedWords.includes(x))).slice(0, 50),
    web_searches_unverified: list.filter(e => e.google_suggest && !fiverrBacked(e)).slice(0, 25).map(e => e.keyword),
    seller_keywords_not_in_buyer_searches: list.filter(e => !e.buyer_search && !e.fiverr_tag_page && !e.google_suggest).slice(0, 30),
    notes: ['web_searches_unverified are Google-only suggestions (often DIY/news); do not use them as Fiverr keywords. fiverr_tag_page=true: Fiverr itself has a search-tag page for it (Fiverr tag directory). buyer_search=true: it appeared in search autocomplete. Neither is a search-volume number.', 'gig_tags / seller_titles count how many collected gigs target the phrase = competition, not demand.', 'Next: think as different buyers (occasion, genre, platform, audience, style), pick 3-8 niche-down keywords and run compare_keywords on them (one cheap run) to compare competition.'],
  };
}
