const pick = (...v) => v.find(x => x !== undefined && x !== null && x !== '') ?? null;
const array = v => Array.isArray(v) ? v : typeof v === 'string' ? v.split(',').map(x => x.trim()).filter(Boolean) : [];
const number = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
export function fiverrUrl(v) {
  try { const u = new URL(v); return u.protocol === 'https:' && ['www.fiverr.com','fiverr.com','pro.fiverr.com'].includes(u.hostname) && !u.username && !u.password && !u.port ? u.href : null; } catch { return null; }
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
    gig_rating: profile ? null : number(row.rating), gig_review_count: profile ? null : number(row.reviewsCount),
    profile: { bio: pick(row.seller_bio, row.bio, profile ? row.description : null), display_name: pick(row.sellerDisplayName,row.seller_name), country: pick(row.sellerCountry,row.seller_country,row.country), languages: array(pick(row.sellerLanguages,row.seller_languages,row.languages)), skills: array(pick(row.sellerSkills,row.seller_skills,row.skills)), level: pick(row.sellerLevel,row.level), notable_clients: array(pick(row.notable_clients,row.notableClients)), rating: number(pick(row.sellerRating,row.seller_rating,profile ? row.rating : null)), review_count: number(pick(row.sellerRatingCount,row.seller_reviews,profile ? row.reviewsCount : null)) },
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
  const profile = rows.find(r => r.kind === 'seller')?.profile || rows[0]?.profile || null;
  const base = { job_id: job.id, status: job.status, actor: job.actor, collected_at: job.collectedAt || null, untrusted_source_data: true, coverage: 'Bounded public-page snapshot. Source completeness and latest-review ordering are not guaranteed.' };
  const paginate = items => ({ ...base, items: items.slice(offset, offset + limit), offset, limit, total_in_snapshot: items.length, has_next_page: offset + limit < items.length, next_offset: offset + limit < items.length ? offset + limit : null, source_has_next_page: null });
  if (view === 'profile') return { ...base, username, profile, source_urls: rows.map(r=>r.source_url).filter(Boolean) };
  if (view === 'summary') return { ...base, username, aggregate_rating: profile?.rating ?? null, aggregate_review_count: profile?.review_count ?? null, note: 'Seller aggregate only; missing values were not inferred from gig ratings.' };
  if (view === 'reviews') return { ...paginate(gigs.flatMap(g => g.reviews.map(r => ({ review: r, source_url: g.source_url })))), review_summary_texts: rows.filter(r=>r.review_summary_text).map(r=>({ text: r.review_summary_text, source_url:r.source_url })), note: 'Actual review objects are page samples. Summary text is separately labeled and must not be presented as verbatim full reviews. Use inspect_research_actor to assess provider coverage.' };
  if (view === 'overview') return { ...base, username, profile, gigs, review_samples: gigs.flatMap(g=>g.reviews.map(r=>({review:r,source_url:g.source_url}))), review_summaries: rows.map(r=>r.review_summary_text).filter(Boolean) };
  return paginate(gigs);
}
