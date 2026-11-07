const ROOT = 'https://api.apify.com/v2';
export const ACTORS = {
  memo23: { id: 'memo23/fiverr-scraper', build: '0.1.66', buildId:'eDtDB3NUQ1c7bCTSm', modes: ['search', 'seller', 'gig'], note: 'Detailed gigs and seller profiles; page review samples only. Extended review option is documented as available from 20 November 2026 and is deliberately not used.' },
  logiover: { id: 'logiover/fiverr-scraper', build: '1.0.19', buildId:'4PFv9jAZXnNJmlTMN', modes: ['search', 'seller', 'gig'], note: 'Search filters, seller portfolio and detailed gig tags. Does not guarantee complete review history.' },
  vexaloom: { id: 'vexaloom-labs/fiverr-gig-and-seller-sitemap-directory-scraper', build: '1.0.2', buildId: 'ioz3XdgkePJ4Ysh8m', modes: ['tags', 'compare'], note: 'Fiverr search-tag directory (Fiverr own list of search terms) and multi-keyword competition check: total results, price range, page-1 positions.' },
  dionysus: { id: 'dionysus_way/fiverr', build: '1.0.17', buildId:'gHBBb4MRe0UvbW0sv', modes: ['search', 'seller', 'gig'], note: 'Additional seller bios, notable clients where exposed, and textual recent-review summaries.' },
};
export function actorInput(adapter, mode, args) {
  // Fiverr shows ~48 gigs per search page; pages=5 => first five result pages.
  if (mode === 'search' && args.pages) args = { ...args, limit: args.pages * 48 };
  if (mode === 'sellers') args = { ...args, limit: args.usernames.length * 10 };
  const urls = mode === 'seller' || mode === 'sellers' ? (args.usernames || [args.username]).map(u => `https://www.fiverr.com/${u}`) : args.urls;
  if (adapter === 'vexaloom') return mode === 'gig' ? { mode: 'gigDetails', gigUrls: urls, includePackages: true, includeFaq: true, maxItems: urls.length }
    : mode === 'tags'
    ? { mode: 'sitemapDirectory', sitemapType: 'tags', searchKeyword: args.tag_filter, maxShards: 2, maxItems: 500 }
    : { mode: 'search', searchQueries: args.keywords, maxPagesPerQuery: 1, includeMarketSummary: true, maxItems: args.keywords.length * 50 };
  if (adapter === 'memo23') return { ...(mode === 'search' ? { searchQueries: [args.buyer_need] } : { startUrls: urls }), scrapeDetails: true, maxItems: args.limit, maxItemsPerSearch: args.limit, maxConcurrency: 4 };
  if (adapter === 'logiover') return { mode: mode === 'gig' ? 'gigDetail' : mode, ...(mode === 'search' ? { query: args.buyer_need } : mode === 'seller' ? { seller: args.username } : { gigUrls: urls }), maxResults: args.limit };
  if (adapter === 'dionysus') return { startUrls: mode === 'search' ? [`https://www.fiverr.com/search/gigs?query=${encodeURIComponent(args.buyer_need)}`] : urls, maxItemsPerUrl: Math.max(1, Math.floor(args.limit / (urls?.length || 1))) };
  throw new Error('Unknown inspected adapter.');
}

export class Apify {
  constructor(fetcher = fetch) { this.fetcher = fetcher; this.schemaCache = new Map(); }
  async request(path, token, options = {}) {
    let response;
    try {
      response = await this.fetcher(ROOT + path, { ...options, headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.body ? { 'Content-Type': 'application/json' } : {}) }, signal: AbortSignal.timeout(25000) });
    } catch { throw new Error('Apify connection timed out or failed. A start request may have reached Apify; inspect your Apify Console before retrying.'); }
    if (!response.ok) {
      const error = new Error(`Apify returned HTTP ${response.status}. Check credentials, actor access, balance, and run limits in Apify Console.`);
      error.status = response.status; throw error;
    }
    if (response.status === 204) return null;
    const body = await response.text();
    return body ? JSON.parse(body) : null;
  }
  async inspect(adapter) {
    const a = ACTORS[adapter];
    const value = await this.request(`/actor-builds/${a.buildId}`);
    const schema = typeof value.data.inputSchema === 'string' ? JSON.parse(value.data.inputSchema) : value.data.inputSchema;
    if (!schema?.properties) throw new Error('Actor input schema is unavailable; execution refused.');
    this.schemaCache.set(adapter, schema);
    return { actor: a.id, build: a.build, input_schema: schema, readme: value.data.readme, limitations: a.note };
  }
  async start(adapter, input, token, maxCharge) {
    if (!token) throw new Error('APIFY_TOKEN is not configured on the server.');
    if (!this.schemaCache.has(adapter)) await this.inspect(adapter);
    const schema = this.schemaCache.get(adapter);
    for (const key of Object.keys(input)) if (!(key in schema.properties)) throw new Error(`Actor schema changed: unsupported field ${key}. Update adapter before running.`);
    for (const key of schema.required || []) if (!(key in input)) throw new Error(`Actor now requires ${key}; update adapter before running.`);
    const a = ACTORS[adapter];
    const params = new URLSearchParams({ build: a.build, timeout: '900', memory: '512', maxTotalChargeUsd: String(maxCharge) });
    const result = await this.request(`/acts/${a.id.replace('/', '~')}/runs?${params}`, token, { method: 'POST', body: JSON.stringify(input) });
    return result.data;
  }
  async poll(runId, token) { return (await this.request(`/actor-runs/${encodeURIComponent(runId)}`, token)).data; }
  async items(datasetId, token, offset = 0, limit = 100) {
    return this.request(`/datasets/${encodeURIComponent(datasetId)}/items?clean=true&format=json&offset=${offset}&limit=${limit}`, token);
  }
  async discover(query) {
    const result = await this.request(`/store?search=${encodeURIComponent(query)}&limit=10`);
    return result.data.items.map(a => ({ actor: `${a.username}/${a.name}`, title: a.title, description: a.description, url: a.url, pricing: a.currentPricingInfo, inspected_adapter: Object.entries(ACTORS).find(([, v]) => v.id === `${a.username}/${a.name}`)?.[0] || null }));
  }
}
