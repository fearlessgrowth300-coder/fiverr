// Google search volume + 12-month trend via DataForSEO (seller's own account, pay-as-you-go).
export async function searchVolume({ login, password }, keywords, location_code = 2840, fetchImpl = fetch) {
  const r = await fetchImpl('https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live', {
    method: 'POST', signal: AbortSignal.timeout(60000),
    headers: { authorization: 'Basic ' + Buffer.from(`${login}:${password}`).toString('base64'), 'content-type': 'application/json' },
    body: JSON.stringify([{ keywords, location_code, language_code: 'en' }]),
  });
  const d = await r.json().catch(() => ({}));
  const t = d.tasks?.[0];
  if (!r.ok || d.status_code !== 20000 || t?.status_code !== 20000) throw new Error(`DataForSEO: ${t?.status_message || d.status_message || 'HTTP ' + r.status}`);
  const avg = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null;
  return { cost_usd: d.cost, keywords: (t.result || []).map(k => {
    const m = (k.monthly_searches || []).map(x => ({ month: `${x.year}-${String(x.month).padStart(2, '0')}`, searches: x.search_volume ?? 0 }));
    const recent = avg(m.slice(0, 3).map(x => x.searches)), before = avg(m.slice(3, 12).map(x => x.searches));
    return { keyword: k.keyword, google_monthly_searches: k.search_volume, advertiser_competition: k.competition, cpc_usd: k.cpc,
      trend: recent == null || !before ? null : recent > before * 1.15 ? 'rising' : recent < before * 0.85 ? 'falling' : 'steady',
      peak_month: m.length ? m.reduce((a, b) => b.searches > a.searches ? b : a).month : null, last_12_months: m };
  }) };
}
