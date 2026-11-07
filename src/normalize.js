const pick = (...v) => v.find(x => x !== undefined && x !== null && x !== '') ?? null;
const array = v => Array.isArray(v) ? v : typeof v === 'string' ? v.split(',').map(x => x.trim()).filter(Boolean) : [];
const number = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
export function fiverrUrl(v) {
  try { const u = new URL(v); return u.protocol === 'https:' && ['www.fiverr.com','fiverr.com','pro.fiverr.com'].includes(u.hostname) && !u.username && !u.password && !u.port ? `https://${u.hostname === 'pro.fiverr.com' ? 'pro.fiverr.com' : 'www.fiverr.com'}${u.pathname.replace(/\/+$/, '').toLowerCase()}` : null; } catch { return null; }
}
export function normalize(row) {
  const source = fiverrUrl(pick(row.gigUrl, row.url, row.sellerUrl));
  const username = pick(row.sellerName, row.seller_username, row.username, row.seller?.username);
  const profile = row.rowType === 'seller' || row.type === 'seller' || (source && new URL(source).pathname.split('/').filter(Boolean).length === 1);
  const p = row.packages || ['basic','standard','premium'].filter(k => row[`price_${k}`] != null).map(k => ({ tier: k, price: number(row[`price_${k}`]), delivery_days: number(row[`delivery_${k}`]), revisions: number(row[`revisions_${k}`]), features: array(row[`features_${k}`]) }));
  return {
    kind: profile ? 'seller' : 'gig', username, source_url: source,
    title: profile ? null : pick(row.title), description: pick(row.description),
    category: pick(row.category, row.category_name), subcategory: pick(row.subCategory, row.category_sub),
    tags: array(row.tags), price_from: number(pick(row.priceFrom, row.price)), currency: pick(row.currency), packages: p,
    gig_rating: profile ? null : number(pick(row.buyingReviewRating, row.rating)), gig_review_count: profile ? null : number(pick(row.buyingReviewsCount, row.reviewsCount)),
    orders_in_queue: number(pick(row.ordersInQueue, row.orders_in_queue)),
    profile: { bio: pick(row.seller_bio, row.bio, profile ? row.description : null), display_name: pick(row.sellerDisplayName,row.seller_name), country: pick(row.sellerCountry,row.seller_country,row.country), languages: array(pick(row.sellerLanguages,row.seller_languages,row.languages)), skills: array(pick(row.sellerSkills,row.seller_skills,row.skills)), level: pick(row.sellerLevel,row.level)?.toString().toLowerCase().replace(/\s+/g,'_') ?? null, notable_clients: array(pick(row.notable_clients,row.notableClients)), rating: number(pick(row.sellerRating,row.seller_rating,profile ? row.rating : null)), review_count: number(pick(row.sellerRatingCount,row.seller_reviews,profile ? row.reviewsCount : null)) },
    images: array(pick(row.images,row.gallery_images,row.gallery)),
    reviews: Array.isArray(row.reviews) ? row.reviews : Array.isArray(row.topReviews) ? row.topReviews : [],
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
  const words = new Map(), phrases = new Map(), tags = new Map(), levels = new Map(), prices = [[], [], []], days = [[], [], []];
  for (const g of gigs) {
    const w = (g.title || '').toLowerCase().replace(/^i will /, '').match(/[\p{L}\p{N}]+/gu) || [];
    new Set(w.filter(x => !STOP.has(x))).forEach(x => inc(words, x));
    new Set(w.slice(1).map((x, i) => w[i] + ' ' + x).filter(b => b.split(' ').some(x => !STOP.has(x)))).forEach(b => inc(phrases, b));
    new Set(g.tags.map(t => t.toLowerCase().trim())).forEach(t => inc(tags, t));
    inc(levels, g.profile?.level || 'unknown');
    const ps = (g.packages || []).map(p => ({ price: number(p.price), days: number(p.durationDays ?? p.deliveryDays ?? p.delivery_days) })).filter(p => p.price != null).sort((a, b) => a.price - b.price);
    if (!ps.length && g.price_from != null) ps.push({ price: g.price_from, days: null });
    ps.slice(0, 3).forEach((p, i) => { prices[i].push(p.price); if (p.days != null) days[i].push(p.days); });
  }
  const stats = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return { gigs: s.length, min: s[0], median: s[s.length >> 1], max: s.at(-1) }; };
  const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([term, count]) => ({ term, gigs: count }));
  const card = g => ({ position: g.position, page: g.page, title: g.title, url: g.source_url, seller: g.username, level: g.profile?.level, gig_rating: g.gig_rating, gig_reviews: g.gig_review_count, orders_in_queue: g.orders_in_queue, price_from: g.price_from, tags: g.tags });
  const by = k => [...gigs].filter(g => g[k] != null).sort((a, b) => b[k] - a[k]).slice(0, 10).map(card);
  return {
    job_id: job.id, search: job.query, gigs_analyzed: gigs.length, pages_covered: Math.max(0, ...gigs.map(g => g.page || 0)),
    gigs_with_tags: gigs.filter(g => g.tags.length).length, gigs_with_description: gigs.filter(g => g.description).length,
    title_words: top(words, 25), title_phrases: top(phrases, 20), tags: top(tags, 30),
    prices_usd: { basic: stats(prices[0]), standard: stats(prices[1]), premium: stats(prices[2]) },
    delivery_days: { basic: stats(days[0]), standard: stats(days[1]), premium: stats(days[2]) },
    seller_levels: Object.fromEntries(levels),
    first_page: gigs.filter(g => g.page === 1).slice(0, 12).map(card),
    most_reviewed: by('gig_review_count'), busiest_now: by('orders_in_queue'),
    notes: ['Counts are how many gigs use a word/tag, NOT buyer search volume.', 'Review counts and orders in queue are proxies for what buyers buy, not sales figures.', 'Positions follow scraper order and approximate Fiverr search ranking (~48 gigs per page).'],
  };
}
