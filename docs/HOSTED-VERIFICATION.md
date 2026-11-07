# Hosted edition verification

7 November 2026: `npm run check` passes all 19 tests, including actual MCP SDK clients for stdio, local HTTP and the hosted Express endpoint. The new tests verify encrypted credential integrity and expiry, different sellers' storage isolation, cold-start job resumption, registration consent and origin checks, and a complete mocked paid-research lifecycle through MCP.

The web page was inspected in the browser, including the ChatGPT/Claude instruction tabs. Dependency audit reports no known vulnerabilities. No seller API token was supplied and no paid live scrape was started. A live credential connection and scrape remain to be verified by a seller with their own token.

For the hosted runtime, use README.md and app.js. The earlier VERIFICATION.md describes the original single-user local version, whose transport tests are retained.
