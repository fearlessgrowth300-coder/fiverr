# Gig Studio — hosted Fiverr research MCP

A multi-seller service for ChatGPT and Claude. Every seller connects **their own Apify API key** through the web page. No terminal is required for sellers.

## Seller setup

1. Open the deployed website and connect your own Apify key.
2. Save the private workspace key shown once on the page.
3. Add the site's `/mcp` address as a custom connector in ChatGPT or Claude, selecting no sign-in.
4. Enable the connector and supply your workspace key and actual service in your private chat.

The service has 15 MCP tools, covering discovery, seller profiles, aggregate ratings, actual review samples, gigs, detail pages, research history and full-gig validation. The host AI writes the original copy. The complete output includes a 78-character full title, five tags, a 1,200-character description, three packages, profile/skills, FAQs, buyer requirements and image briefs.

## Vercel deployment

Import this repository as an **Express** project. `app.js` exports the Express app. Set one production secret before enabling registration:

```
WORKSPACE_ENCRYPTION_KEY=<64 random hex characters>
```

Generate it with a cryptographically secure random generator. Never commit it. Keep it stable across releases; rotating it invalidates all workspace keys. `/health` and `/api/status` show whether it is configured, without revealing the secret. Vercel supplies HTTPS and the permanent deployment hostname. `/mcp` uses stateless Streamable HTTP with JSON responses. The production hostname must be accessible to the chat providers; preview deployments may have Vercel authentication protection.

The website, `/api/connect`, `/health` and `/mcp` all run in this one Express deployment. No filesystem writes or background worker loops are used by the hosted path. No shared Apify token is configured.

## Multi-seller isolation and persistence

- `/api/connect` verifies the seller's token with Apify and creates/opens a named `fiverr-gig-studio` key-value store in **that seller's account**.
- The token and account/store identifiers are sealed into an AES-256-GCM workspace key with a 90-day expiry. The raw token is never put into chat, Git, logs, browser storage or the research store by this application.
- The workspace key is a bearer secret. It is visible to the seller's chosen chat provider when used. Anyone with that key can use these tools as that seller. Keep it private. Revoking the underlying Apify token prevents further Apify access; reconnect to use a replacement token.
- Research metadata and normalized evidence persist in the seller's Apify store. Separate per-job records prevent one seller or unrelated request from overwriting another seller's state.
- Each research operation sends only the task-specific buyer query or public Fiverr URLs, not the rest of the conversation.
- Existing job IDs resume work after a cold start. Paid starts are never automatically retried after uncertainty. Identical sequential searches reuse a cached job for one hour.

The named store is retained according to Apify's storage policy. Sellers can manage/delete it in their Apify Console. The app does not copy the API token into stored job records. The encrypted workspace key remains on the browser page until cleared/reloaded; it is not automatically saved.

## Billing and limits

Research is billed to each seller's Apify account. Connecting an account verifies credentials and opens storage; it does not start a paid Actor run. Storage/API usage is subject to Apify's own pricing.

Each run requests a maximum of 50 result rows, a 180-second timeout and `maxTotalChargeUsd=0.50`. Apify minimum/event/platform charges may differ. Sellers must use Apify account spending limits for their overall budget.

Unlike the original single-process local edition, the hosted edition **does not claim an atomic daily or concurrency quota**. Its query cache is best-effort; simultaneous identical requests can race and start more than one run. Do not use it as a billing cap. Apify has no compare-and-swap primitive in the key-value storage API used here. A shared billing model would need a transactional quota/locking store before release.

## Research limitations

Three real, schema-checked Apify adapters are supported: `memo23/fiverr-scraper`, `logiover/fiverr-scraper`, and `dionysus_way/fiverr`. Catalog discovery can find more, but arbitrary uninspected actors are not executed.

Public-page review samples are not complete review histories or guaranteed newest-first reviews. Pagination exhausts the collected snapshot, not all Fiverr data. A seller's rating is never calculated from a simple average of gig ratings. Missing fields remain unknown. Category acceptance, actual credentials, capacity and pricing must be confirmed by the seller. Images are original design briefs, not generated image files. No Fiverr publishing, seller messaging or hiring is performed.

## Development and verification

Node 24 recommended.

```sh
npm ci
# Create .env with WORKSPACE_ENCRYPTION_KEY for local hosted-mode testing.
npm start
npm run check
node scripts/check-actors.mjs
```

Tests cover local and hosted MCP connections, encrypted workspace tamper/expiry checks, distinct seller stores, cold-start resumption, API input mapping, exact field validation and source provenance. Paid Apify responses are mocked in tests. Live scraper output requires a real seller token and paid run, and is not established by schema checks alone.

The original single-user transport remains available through `npm run local` / `npm run stdio`. It uses its own local config and file store; Vercel imports `app.js`, not that path.

## Sources

- [Vercel Express deployment](https://vercel.com/docs/frameworks/backend/express)
- [Apify key-value storage](https://docs.apify.com/storage/key-value-store)
- [ChatGPT custom MCP setup](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [Claude custom MCP setup](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
- [Fiverr gig fields](https://help.fiverr.com/hc/en-us/articles/360010451397-Creating-a-Gig)
