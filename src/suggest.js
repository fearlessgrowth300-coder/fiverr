// Free AnswerThePublic-style ideas: Google + YouTube autocomplete around a seed. No key needed.
const PATTERNS = s => [s, `${s} for`, `${s} with`, `${s} vs`, `${s} to`, `custom ${s}`, `best ${s}`, `cheap ${s}`, `professional ${s}`,
  `how to ${s}`, `what is ${s}`, `can ${s}`, `${s} ideas`, ...'abcdefghijklmnopqrstuvwxyz'.split('').map(c => `${s} ${c}`)];

export async function suggestions(seed, { sources = ['google', 'youtube'], fetchImpl = fetch } = {}) {
  const s = seed.trim().toLowerCase();
  const jobs = sources.flatMap(src => PATTERNS(s).map(q => ({ src, q })));
  const found = new Map(); let ok = 0, blocked = 0;
  // ponytail: 8 at a time; lower it if Google starts refusing.
  for (let i = 0; i < jobs.length; i += 8) await Promise.all(jobs.slice(i, i + 8).map(async ({ src, q }) => {
    try {
      const r = await fetchImpl(`https://suggestqueries.google.com/complete/search?client=firefox&hl=en&gl=us&ie=utf8&oe=utf8${src === 'youtube' ? '&ds=yt' : ''}&q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) { blocked++; return; }
      const [, list] = JSON.parse(Buffer.from(await r.arrayBuffer()).toString('utf8'));
      ok++;
      for (const t of list || []) { if (t === s) continue; const e = found.get(t) || { suggestion: t, sources: new Set(), seen: 0 }; e.sources.add(src); e.seen++; found.set(t, e); }
    } catch { blocked++; }
  }));
  if (!ok) throw new Error('Google autocomplete is not reachable from this server right now.');
  const all = [...found.values()].map(e => ({ suggestion: e.suggestion, sources: [...e.sources], seen: e.seen })).sort((a, b) => b.seen - a.seen || b.sources.length - a.sources.length);
  const Q = /^(how|what|can|why|where|which)\b/, has = re => all.filter(x => re.test(x.suggestion));
  return {
    seed: s, requests_ok: ok, requests_failed: blocked, total: all.length,
    buyer_modifiers: has(/\b(for|with|to|custom|best|cheap|professional)\b/).filter(x => !Q.test(x.suggestion)), questions: has(Q), comparisons: has(/\bvs\b/), all,
    note: 'Real autocomplete phrases people type into Google/YouTube. Not volume: run the promising ones through compare_keywords (Fiverr competition) and google_search_volume (demand). "how to" phrases are mostly DIY learners; use them for buyer problems and FAQ, not as the target keyword.',
  };
}
