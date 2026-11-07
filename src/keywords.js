// Real buyer searches: Fiverr's own search autocomplete (what buyers type), Google suggest as fallback.
const STOP = new Set('i will a an the and or for your you to of in with on my me by from as at be is it this that'.split(' '));
const words = s => String(s || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];

async function suggest(q, fetcher) {
  const get = url => fetcher(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' }, signal: AbortSignal.timeout(8000) }).then(r => r.ok ? r.text() : Promise.reject(new Error(r.status)));
  try {
    const t = await get(`https://www.fiverr.com/search/autocomplete?query=${encodeURIComponent(q)}`);
    const json = JSON.parse(t.slice(t.indexOf('(') + 1, t.lastIndexOf(')')));
    return { source: 'fiverr_autocomplete', items: json.suggestions.map(s => String(s.value).toLowerCase()) };
  } catch {
    try {
      const t = await get(`https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(q)}`);
      return { source: 'google_suggest', items: JSON.parse(t)[1].map(s => String(s).toLowerCase()) };
    } catch { return { source: 'unavailable', items: [] }; }
  }
}

export async function buyerKeywordIdeas(seed, job, fetcher = fetch) {
  seed = seed.toLowerCase().trim();
  const queries = [seed, `${seed} for`, `${seed} with`, ...'abcdefghijklmnopqrstuvwxyz'.split('').map(l => `${seed} ${l}`)];
  const results = [];
  for (let i = 0; i < queries.length; i += 6) results.push(...await Promise.all(queries.slice(i, i + 6).map(q => suggest(q, fetcher)))); // polite: 6 at a time
  const seedWords = words(seed).filter(w => !STOP.has(w));
  const ideas = new Map();
  const add = (kw, key) => { kw = kw.trim(); if (!kw || kw.length > 60) return; const e = ideas.get(kw) || { keyword: kw, buyer_search: false, gig_tags: 0, seller_titles: 0 }; if (key === 'buyer_search') e.buyer_search = true; else e[key]++; ideas.set(kw, e); };
  for (const r of results) for (const kw of r.items) add(kw, 'buyer_search');
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
  const list = [...ideas.values()].filter(e => e.buyer_search || e.gig_tags > 1 || e.seller_titles > 1)
    .map(e => ({ ...e, signal: (e.buyer_search ? 3 : 0) + Math.min(e.gig_tags, 10) * 0.5 + Math.min(e.seller_titles, 10) * 0.3 }))
    .sort((a, b) => b.signal - a.signal);
  const sources = [...new Set(results.map(r => r.source))];
  return {
    seed, buyer_search_source: sources.includes('fiverr_autocomplete') ? 'Fiverr search autocomplete (real buyer searches on Fiverr)' : sources.includes('google_suggest') ? 'Google suggest (Fiverr autocomplete unavailable from the server)' : 'unavailable',
    buyer_searches: list.filter(e => e.buyer_search).slice(0, 60),
    niche_down: list.filter(e => e.buyer_search && words(e.keyword).length > words(seed).length).slice(0, 40),
    seller_keywords_not_in_buyer_searches: list.filter(e => !e.buyer_search).slice(0, 30),
    notes: ['buyer_search=true means it appeared in search autocomplete (people type it); it is not a search-volume number.', 'gig_tags / seller_titles count how many collected gigs target the phrase = competition, not demand.', 'Next: think as different buyers (occasion, genre, platform, audience, style), pick 3-8 niche-down keywords and run find_freelancers with quick=true on each to compare competition.'],
  };
}
