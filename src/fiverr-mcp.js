import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Fiverr's official public MCP connector: free, no sign-in, live seller data. Its Mira tools are not used: Mira only serves people hiring.
const URL_ = new URL('https://mcp.fiverr.com/mcp');
// Avatars only bloat what the AI has to read.
const strip = v => Array.isArray(v) ? v.map(strip) : v && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).filter(([k]) => !/^(photoUrl|reviewer_image_url|profile_image|avatar)/i.test(k)).map(([k, x]) => [k, strip(x)])) : v;

export class FiverrMcp {
  async call(name, args) {
    const c = new Client({ name: 'fiverr-gig-studio', version: '1' });
    try {
      await c.connect(new StreamableHTTPClientTransport(URL_));
      const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 45000 });
      const text = r.content?.find(x => x.type === 'text')?.text;
      if (r.isError) throw new Error(`Fiverr connector error: ${String(text).slice(0, 200)}`);
      if (r.structuredContent) return strip(r.structuredContent);
      try { return strip(JSON.parse(text)); } catch { return { text }; }
    } finally { await c.close().catch(() => {}); }
  }
  // Up to 20 sellers, 4 at a time. One seller failing does not lose the others.
  async deepDive(usernames) {
    const one = async username => {
      const [overview, reviews, gigs] = await Promise.allSettled([
        this.call('get_freelancer_overview', { username }),
        this.call('list_seller_reviews', { username, limit: 20, sort_by: 'recent' }),
        this.call('list_seller_gigs', { username, limit: 20 }),
      ]);
      const val = x => x.status === 'fulfilled' ? x.value : null;
      return { username, overview: val(overview), reviews: val(reviews), gigs: val(gigs), failed: [overview, reviews, gigs].every(x => x.status === 'rejected') };
    };
    const sellers = [];
    for (let i = 0; i < usernames.length; i += 4) sellers.push(...await Promise.all(usernames.slice(i, i + 4).map(one)));
    if (sellers.every(s => s.failed)) throw new Error('Fiverr connector unavailable.');
    return sellers;
  }
}
