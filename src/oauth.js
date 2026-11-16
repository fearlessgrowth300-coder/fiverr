import express from 'express';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// Stateless OAuth 2.1 (PKCE + dynamic client registration) so ChatGPT/Claude hold the workspace key
// as a bearer token. Everything the flow needs is sealed with the server secret: no database.
const b64 = b => b.toString('base64url');
function sealer(secret) {
  const key = createHash('sha256').update('oauth:' + secret).digest();
  return {
    seal(obj, ttlMs) {
      const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([c.update(JSON.stringify({ ...obj, exp: Date.now() + ttlMs })), c.final()]);
      return b64(Buffer.concat([iv, c.getAuthTag(), body]));
    },
    open(s) {
      try {
        const buf = Buffer.from(String(s), 'base64url'), d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
        d.setAuthTag(buf.subarray(12, 28));
        const o = JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString());
        return o.exp > Date.now() ? o : null;
      } catch { return null; }
    },
  };
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const page = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Gig Studio</title><link rel="stylesheet" href="/style.css"></head><body><main class="setup-card" style="max-width:560px;margin:40px auto;padding:24px">${body}</main></body></html>`;

export function oauthRoutes(app, { secret, readKey }) {
  const S = () => sealer(secret);
  const origin = req => `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`;
  const form = express.urlencoded({ extended: false, limit: '32kb' });

  const resource = (req, res) => res.json({ resource: origin(req) + '/mcp', authorization_servers: [origin(req)], bearer_methods_supported: ['header'] });
  app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], resource);
  app.get(['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration'], (req, res) => {
    const o = origin(req);
    res.json({ issuer: o, authorization_endpoint: o + '/oauth/authorize', token_endpoint: o + '/oauth/token', registration_endpoint: o + '/oauth/register',
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['research'] });
  });

  app.post('/oauth/register', (req, res) => {
    const uris = req.body?.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every(u => typeof u === 'string' && /^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(u))) return res.status(400).json({ error: 'invalid_redirect_uri' });
    res.status(201).json({ client_id: S().seal({ r: uris }, 10 * 365 * 86400000), redirect_uris: uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], client_name: req.body?.client_name || 'MCP client' });
  });

  const checkAuthz = q => {
    const client = S().open(q.client_id);
    if (!client) return 'Unknown client. Remove and add the connector again.';
    if (!client.r.includes(q.redirect_uri)) return 'Redirect address not registered for this client.';
    if (q.response_type !== 'code' || !q.code_challenge || q.code_challenge_method !== 'S256') return 'Unsupported sign-in request (PKCE S256 required).';
    return null;
  };
  const hidden = q => ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'response_type', 'scope'].map(k => `<input type="hidden" name="${k}" value="${esc(q[k])}">`).join('');
  const show = (req, res, q, error) => {
    let to = ''; try { to = new URL(q.redirect_uri).origin; } catch {}
    res.set('Content-Security-Policy', `default-src 'self'; style-src 'self'; form-action 'self' ${to}; frame-ancestors 'none'; base-uri 'none'`);
    res.status(error ? 400 : 200).send(page(`<h3>Connect Fiverr Gig Studio</h3><p>Paste your private workspace key from <a href="/" target="_blank">the Gig Studio website</a>. It is stored by your AI app, not shown in chats.</p>${error ? `<p class="status" style="color:#b00020">${esc(error)}</p>` : ''}<form method="post" action="/oauth/authorize">${hidden(q)}<label for="k">Workspace key</label><textarea id="k" name="workspace_key" rows="5" required spellcheck="false" autocomplete="off"></textarea><button class="button dark full" type="submit">Connect</button></form>`));
  };
  app.get('/oauth/authorize', (req, res) => { const e = checkAuthz(req.query); if (e) return res.status(400).send(page(`<p>${esc(e)}</p>`)); show(req, res, req.query); });
  app.post('/oauth/authorize', form, (req, res) => {
    const q = req.body || {}, e = checkAuthz(q);
    if (e) return res.status(400).send(page(`<p>${esc(e)}</p>`));
    const key = String(q.workspace_key || '').replace(/\s/g, '');
    try { readKey(key); } catch (err) { return show(req, res, q, err.message); }
    const url = new URL(q.redirect_uri);
    url.searchParams.set('code', S().seal({ k: key, r: q.redirect_uri, c: q.code_challenge, cid: q.client_id }, 5 * 60000));
    if (q.state) url.searchParams.set('state', q.state);
    res.redirect(302, url.toString());
  });

  app.post('/oauth/token', form, (req, res) => {
    const b = req.body || {}, bad = (d = 'invalid_grant') => res.status(400).json({ error: d });
    let key;
    if (b.grant_type === 'authorization_code') {
      const c = S().open(b.code);
      if (!c || c.r !== b.redirect_uri || (b.client_id && b.client_id !== c.cid)) return bad();
      if (!b.code_verifier || b64(createHash('sha256').update(String(b.code_verifier)).digest()) !== c.c) return bad();
      key = c.k;
    } else if (b.grant_type === 'refresh_token') {
      const r = S().open(b.refresh_token); if (!r) return bad(); key = r.k;
    } else return bad('unsupported_grant_type');
    try { readKey(key); } catch { return bad(); }
    res.set('Cache-Control', 'no-store').json({ access_token: key, token_type: 'Bearer', expires_in: 30 * 86400, refresh_token: S().seal({ k: key }, 90 * 86400000), scope: 'research' });
  });
}
