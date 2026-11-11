import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Fiverr's official public MCP connector: free, no sign-in, live seller data and Mira.
const URL_ = new URL('https://mcp.fiverr.com/mcp');
// Sent ahead of the first Mira message: she is told the truth, so no fake hiring need is created.
export const MIRA_INTRO = "I'm a Fiverr seller doing market research for my own gig. I'm not hiring and won't submit a brief. ";
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
  // Mira, research only. take_brief_to_mira is deliberately not exposed: it would turn this into a real hiring brief.
  async askMira({ message, turn_id = '', mira_key = '' }) {
    const r = await this.call('talk_to_mira', { message: message && !mira_key ? MIRA_INTRO + message : message, turn_id, workspace_key: mira_key });
    return { reply: r.reply, status: r.status, turn_id: r.turnId, mira_key: r.workspaceKey, question: r.widget ?? null, untrusted_source_data: true,
      note: 'Research only: relay what Mira said. If she offers a brief, quotes or hiring, decline; no brief is ever submitted from Gig Studio.' };
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
