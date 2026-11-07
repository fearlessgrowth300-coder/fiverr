const pick = (...v) => v.find(x => x !== undefined && x !== null && x !== '') ?? null;
const array = v => Array.isArray(v) ? v : typeof v === 'string' ? v.split(',').map(x => x.trim()).filter(Boolean) : [];
const number = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
export function fiverrUrl(v) {
  try { const u = new URL(v); return u.protocol === 'https:' && ['www.fiverr.com','fiverr.com','pro.fiverr.com'].includes(u.hostname) && !u.username && !u.password && !u.port ? `https://${u.hostname === 'pro.fiverr.com' ? 'pro.fiverr.com' : 'www.fiverr.com'}${u.pathname.replace(/\/+$/, '').toLowerCase()}` : null; } catch { return null; }
}
export function normalize(row) {
  const source = fiverrUrl(pick(row.gigUrl, row.sourceUrl, row.url, row.sellerUrl, row.sellerProfileUrl));
  const username = pick(row.sellerName, row.sellerUsername, row.seller_username, row.username, row.seller?.username);
  const profile = row.rowType === 'seller' || row.type === 'seller' || (source && new URL(source).pathname.split('/').filter(Boolean).length === 1);
  const p = row.packages || ['basic','standard','premium'].filter(k => row[`price_${k}`] != null).map(k => ({ tier: k, price: number(row[`price_${k}`]), delivery_days: number(row[`delivery_${k}`]), revisions: number(row[`revisions_${k}`]), features: array(row[`features_${k}`]) }));
  const nm = v => typeof v === 'object' && v ? (v.name ?? v.title ?? v.slug ?? v.value ?? v.url ?? null) : v;
  return {
    kind: row.recordType === 'tag' ? 'tag' : row.recordType === 'marketSummary' ? 'summary' : profile ? 'seller' : 'gig', username, source_url: source,
    tag_name: pick(row.tagName), search_query: pick(row.searchQuery), search_position: number(row.position), search_page: number(row.page),
    summary: row.recordType === 'marketSummary' ? { total_results: number(row.totalResults), sampled: number(row.sampledCount), price_min: number(row.priceMin), price_median: number(row.priceMedian), price_max: number(row.priceMax), seller_levels: row.sellerLevelCounts ?? null, top_countries: row.topSellerCountries ?? null } : null,
    title: profile ? null : pick(row.title), description: pick(row.fullDescription, row.description),
    category: pick(row.category, row.category_name), subcategory: pick(row.subCategory, row.category_sub),
    tags: array(pick(row.tags, row.gigTags)).map(nm).filter(Boolean), price_from: number(pick(row.priceFrom, row.priceMin, row.price)), currency: pick(row.currency), packages: p,
    gig_rating: profile ? null : number(pick(row.buyingReviewRating, row.rating)), gig_review_count: profile ? null : number(pick(row.buyingReviewsCount, row.reviewsCount)),
    orders_in_queue: number(pick(row.ordersInQueue, row.orders_in_queue)),
    metadata: Array.isArray(row.attributes) ? row.attributes.flatMap(a => (a.values || []).map(v => `${a.type}: ${nm(v)}`)) : row.gigMetadata && typeof row.gigMetadata === 'object' ? Object.entries(row.gigMetadata).flatMap(([k, v]) => [].concat(v).filter(x => x != null && typeof x !== 'object').map(x => `${k}: ${x}`)) : [],
    profile: { bio: pick(row.seller_bio, row.bio, row.sellerDescription, row.sellerOneLiner, profile ? row.description : null), display_name: pick(row.sellerDisplayName,row.seller_name), country: pick(row.sellerCountry,row.sellerCountryCode,row.seller_country,row.country), languages: array(pick(row.sellerLanguages,row.seller_languages,row.languages)), skills: array(pick(row.sellerSkills,row.seller_skills,row.skills)), level: pick(row.sellerLevel,row.level)?.toString().toLowerCase().replace(/\s+/g,'_') ?? null, notable_clients: array(pick(row.notable_clients,row.notableClients)), rating: number(pick(row.sellerRating,row.sellerOverallRating,row.seller_rating,profile ? row.rating : null)), review_count: number(pick(row.sellerRatingCount,row.sellerOverallReviewsCount,row.seller_reviews,profile ? row.reviewsCount : null)) },
    images: array(pick(row.images,row.gigGallery,row.gallery_images,row.gallery)).map(nm).filter(Boolean),
    reviews: (Array.isArray(row.reviews) ? row.reviews : Array.isArray(row.topReviews) ? row.topReviews : []).map(r => r && typeof r === 'object' && r.text == null && r.comment != null ? { ...r, text: r.comment, author: r.author ?? r.reviewerUsername, country: r.country ?? r.reviewerCountryCode, date: r.date ?? r.createdAt } : r),
    review_summary_text: pick(row.recent_reviews_summary),
    faq: pick(row.faq,row.faq_summary),
    published: row.isPublished === false || row.published === false ? false : null,
    embedded_gigs: Array.isArray(row.gigs) ? row.gigs : [],
  };
}
export function rowsFor(job, username) {
  let rows = job.rows || [];
  rows = rows.flatMap(r => [r, ...r.embedded_gigs.map(g => normalize({ ...g, sellerName: g.sellerName || r.username }))]);
  if (username) rows = rows.filter(r => r.username?.toLowerCase() === username.toLowerCase());
  return rows;
}
export function viewJob(job, view, username, offset = 0, limit = 10) {
  const rows = rowsFor(job, username);
  const gigs = rows.filter(r => r.kind === 'gig' && r.published !== false);
  const fill = (a, b) => { for (const [k, v] of Object.entries(b || {})) if (a[k] == null || (Array.isArray(a[k]) && !a[k].length)) a[k] = v; return a; };
  const profile = rows.length ? [...rows].sort((a, b) => (b.kind === 'seller') - (a.kind === 'seller')).reduce((p, r) => fill(p, r.profile), {}) : null;
  const base = { job_id: job.id, status: job.status, actor: job.actor, collected_at: job.collectedAt || null, untrusted_source_data: true, coverage: 'Bounded public-page snapshot. Source completeness and latest-review ordering are not guaranteed.' };
  const paginate = items => ({ ...base, items: items.slice(offset, offset + limit), offset, limit, total_in_snapshot: items.length, has_next_page: offset + limit < items.length, next_offset: offset + limit < items.length ? offset + limit : null, source_has_next_page: null });
  if (view === 'profile') return { ...base, username, profile, source_urls: rows.map(r=>r.source_url).filter(Boolean) };
  if (view === 'summary') return { ...base, username, aggregate_rating: profile?.rating ?? null, aggregate_review_count: profile?.review_count ?? null, note: 'Seller aggregate only; missing values were not inferred from gig ratings.' };
  if (view === 'reviews') return { ...paginate(gigs.flatMap(g => g.reviews.map(r => ({ review: r, source_url: g.source_url })))), review_summary_texts: rows.filter(r=>r.review_summary_text).map(r=>({ text: r.review_summary_text, source_url:r.source_url })), note: 'Actual review objects are page samples. Summary text is separately labeled and must not be presented as verbatim full reviews. Use inspect_research_actor to assess provider coverage.' };
  if (view === 'overview') return { ...base, username, profile, gigs, review_samples: gigs.flatMap(g=>g.reviews.map(r=>({review:r,source_url:g.source_url}))), review_summaries: rows.map(r=>r.review_summary_text).filter(Boolean) };
  return paginate(gigs);
}

// Market summary over every collected gig: what's common, what sells, price ranges.
const STOP = new Set('i will a an the and or for your you to of in with on my me by from as at be is it this that any all do get'.split(' '));
export function analyzeJob(job) {
  const gigs = rowsFor(job).filter(r => r.kind === 'gig');
  const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  const meta = new Map(), words = new Map(), phrases = new Map(), tags = new Map(), levels = new Map(), prices = [[], [], []], days = [[], [], []];
  for (const g of gigs) {
    const w = (g.title || '').toLowerCase().replace(/^i will /, '').match(/[\p{L}\p{N}]+/gu) || [];
    new Set(w.filter(x => !STOP.has(x))).forEach(x => inc(words, x));
    new Set(w.slice(1).map((x, i) => w[i] + ' ' + x).filter(b => b.split(' ').some(x => !STOP.has(x)))).forEach(b => inc(phrases, b));
    new Set(g.tags.map(t => t.toLowerCase().trim())).forEach(t => inc(tags, t));
    new Set(g.metadata || []).forEach(m => inc(meta, m));
    inc(levels, g.profile?.level || 'unknown');
    const ps = (g.packages || []).map(p => ({ price: number(p.price ?? p.priceUsd), days: number(p.durationDays ?? p.deliveryDays ?? p.delivery_days) })).filter(p => p.price != null).sort((a, b) => a.price - b.price);
    if (!ps.length && g.price_from != null) ps.push({ price: g.price_from, days: null });
    ps.slice(0, 3).forEach((p, i) => { prices[i].push(p.price); if (p.days != null) days[i].push(p.days); });
  }
  const stats = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return { gigs: s.length, min: s[0], median: s[s.length >> 1], max: s.at(-1) }; };
  const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([term, count]) => ({ term, gigs: count }));
  const card = g => ({ position: g.position, page: g.page, title: g.title, url: g.source_url, seller: g.username, level: g.profile?.level, gig_rating: g.gig_rating, gig_reviews: g.gig_review_count, orders_in_queue: g.orders_in_queue, price_from: g.price_from, tags: g.tags });
  const by = k => [...gigs].filter(g => g[k] != null).sort((a, b) => b[k] - a[k]).slice(0, 10).map(card);
  const seedW = (job.query || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [], before = new Map(), after = new Map();
  let exact = 0;
  for (const g of gigs) {
    const w = (g.title || '').toLowerCase().replace(/^i will /, '').match(/[\p{L}\p{N}]+/gu) || [];
    const i = seedW.length ? w.findIndex((_, k) => seedW.every((s, n) => w[k + n] === s || w[k + n] === s + 's')) : -1;
    if (i < 0) continue;
    exact++;
    if (i > 0 && !STOP.has(w[i - 1])) inc(before, w[i - 1]);
    const tail = w.slice(i + seedW.length, i + seedW.length + 3);
    if (tail.length) inc(after, tail.join(' '));
  }
  const basicMedian = stats(prices[0])?.median ?? null;
  const scored = gigs.map(g => ({ ...card(g), score: scoreGig(g, job.query, { basicMedian }) })).sort((a, b) => b.score.final - a.score.final);
  const candidates = [...new Set([...scored, ...by('gig_review_count'), ...by('orders_in_queue')].map(g => g.seller).filter(Boolean))].slice(0, 20);
  return {
    job_id: job.id, search: job.query, gigs_analyzed: gigs.length, pages_covered: Math.max(0, ...gigs.map(g => g.page || 0)),
    gigs_with_tags: gigs.filter(g => g.tags.length).length, gigs_with_description: gigs.filter(g => g.description).length,
    title_words: top(words, 25), title_phrases: top(phrases, 20), tags: top(tags, 30),
    keyword_patterns: { seed: job.query, titles_with_exact_seed: exact, words_before_seed: top(before, 15), phrases_after_seed: top(after, 15), note: 'How sellers join keywords around the seed, e.g. [cinematic] + ai music video + [for your song].' },
    prices_usd: { basic: stats(prices[0]), standard: stats(prices[1]), premium: stats(prices[2]) },
    delivery_days: { basic: stats(days[0]), standard: stats(days[1]), premium: stats(days[2]) },
    seller_levels: Object.fromEntries(levels), service_options: top(meta, 20),
    top_scored: scored.slice(0, 20),
    deep_dive_candidates: candidates,
    ranking_model: 'final = relevance (title > tags/description > service options, x consistency) x click estimate (images, price vs market, reviews, rating) x conversion estimate (description, packages, FAQ, reviews, orders in queue). Estimated from visible gig data; Fiverr own click/order data and personalization are private.',
    first_page: gigs.filter(g => g.page === 1).slice(0, 12).map(card),
    most_reviewed: by('gig_review_count'), busiest_now: by('orders_in_queue'),
    notes: ['Counts are how many gigs use a word/tag, NOT buyer search volume.', 'Review counts and orders in queue are proxies for what buyers buy, not sales figures.', 'Positions follow scraper order and approximate Fiverr search ranking (~48 gigs per page).'],
  };
}

// ---- Estimated Fiverr ranking model (Fiverr's real formula and click/order data are private) ----
// final ~ relevance to the search x predicted click rate x predicted conversion, from what is visible on the gig.
const words = s => (String(s || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(w => !STOP.has(w));
const share = (terms, text) => { const t = new Set(words(text)); return terms.length ? terms.filter(x => t.has(x) || t.has(x + 's') || t.has(x.replace(/s$/, ''))).length / terms.length : 0; };
const clamp = x => Math.max(0, Math.min(1, x));
const r2 = x => Math.round(x * 100) / 100;
export function scoreGig(g, search, { basicMedian = null, draft = false } = {}) {
  const terms = [...new Set(words(search))], tags = g.tags || [];
  const rel = { title: share(terms, g.title), tags: share(terms, tags.join(' ')), description: share(terms, g.description), service_options: share(terms, (g.metadata || []).join(' ')) };
  const body = new Set(words(`${g.title} ${g.description}`));
  const consistency = tags.length ? tags.filter(t => words(t).every(w => body.has(w))).length / tags.length : 0.5;
  const relevance = (0.5 * rel.title + 0.2 * rel.tags + 0.2 * rel.description + 0.1 * rel.service_options) * (0.5 + 0.5 * consistency);
  const parts = {
    images: clamp((g.images?.length || 0) / 3),
    price_fit: g.price_from == null || !basicMedian ? 0.5 : clamp(basicMedian / g.price_from),
    review_trust: clamp(Math.log10((g.gig_review_count || 0) + 1) / 3),
    rating: g.gig_rating ? clamp(g.gig_rating - 4) : 0,
    description: clamp((g.description?.length || 0) / 1000),
    packages: clamp((g.packages?.length || 0) / 3),
    faq: Array.isArray(g.faq) ? clamp(g.faq.length / 3) : g.faq ? 1 : 0,
    orders_in_queue: clamp(Math.log10((g.orders_in_queue || 0) + 1) / 1.3),
  };
  // A new (draft) gig has no reviews/orders yet: score only what the seller controls.
  const w = (pairs) => { const use = pairs.filter(([k]) => !draft || !['review_trust', 'rating', 'orders_in_queue'].includes(k)); const tot = use.reduce((s, [, x]) => s + x, 0); return use.reduce((s, [k, x]) => s + parts[k] * x, 0) / tot; };
  const click = w([['images', 0.3], ['price_fit', 0.25], ['review_trust', 0.25], ['rating', 0.2]]);
  const conversion = w([['description', 0.25], ['packages', 0.2], ['faq', 0.15], ['review_trust', 0.2], ['rating', 0.1], ['orders_in_queue', 0.1]]);
  return { final: Math.round(100 * Math.cbrt(relevance * click * conversion)), relevance: r2(relevance), click_estimate: r2(click), conversion_estimate: r2(conversion), relevance_parts: { ...Object.fromEntries(Object.entries(rel).map(([k, v]) => [k, r2(v)])), consistency: r2(consistency) }, signals: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, r2(v)])) };
}
const median = a => { const s = a.filter(x => x != null).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };
export function scoreDraft(gig, job) {
  const row = { title: gig.title, tags: gig.tags, description: gig.description, metadata: (gig.service_options || []).flatMap(o => o.values.map(v => `${o.option}: ${v}`)), images: gig.images, packages: Object.values(gig.packages), faq: gig.faq, price_from: gig.packages.basic.price_usd };
  const market = job?.rows ? analyzeJob(job) : null;
  const score = scoreGig(row, gig.target_search, { basicMedian: market?.prices_usd.basic?.median, draft: true });
  if (!market) return { ...score, note: 'Add search_job_id to compare against the researched market.' };
  const mine = new Set(gig.tags.map(t => t.toLowerCase())), titleWords = new Set(words(gig.title));
  return { ...score, vs_market: {
    top20_competitor_relevance_median: median(market.top_scored.map(g => g.score.relevance)),
    your_relevance: score.relevance,
    top_tags_you_use: market.tags.slice(0, 10).filter(t => mine.has(t.term)).map(t => t.term),
    top_tags_missing: market.tags.slice(0, 10).filter(t => !mine.has(t.term)).map(t => t.term),
    top_title_words_missing: market.title_words.slice(0, 10).filter(t => !titleWords.has(t.term)).map(t => t.term),
    market_basic_price_median: market.prices_usd.basic?.median ?? null, your_basic_price: gig.packages.basic.price_usd,
  }, note: 'Estimate from visible gig content only; Fiverr ranking also uses private click/order data and buyer personalization.' };
}
