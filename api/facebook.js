// Miles Man CRM — Facebook OAuth token exchange AND Graph API relay,
// merged into one file.
//
// WHY MERGED: Vercel's Hobby (free) plan caps a deployment at 12 Serverless
// Functions. Adding api/x.js pushed this project's api/ folder to 13 files
// (12 preexisting + x.js), one over the cap. facebook-token.js and
// facebook-graph.js are combined here into a single function to free a
// slot — same reasoning, same technique already used for api/canva.js and
// api/x.js.
//
// WHERE THIS GOES: copy to api/facebook.js in the milesman-auth Vercel
// project (C:\Users\ericl\milesman-auth-fix), then DELETE the old
// api/facebook-token.js and api/facebook-graph.js so the file count
// actually drops. index.html's own calling code still hits the two
// original URLs (/api/facebook-token, /api/facebook-graph) unchanged — a
// vercel.json rewrite (see below) routes both of those paths to this one
// file, so no index.html changes are needed.
//
// HOW THE TWO HALVES ARE TOLD APART: unlike api/x.js (where method alone
// was enough — token exchange is POST, the API relay is GET), Facebook's
// Graph relay itself needs to support POST too (loadFacebookCampaigns's
// activate/pause calls). So routing here is by the "path" query param
// instead: index.html always calls facebook-graph as
// /api/facebook-graph?path=..., and never sends a path param to
// facebook-token. A request with a "path" query param goes to the Graph
// relay (regardless of method); one without goes to the token exchange
// (which must be POST).
//
// REQUIRED vercel.json rewrites (add these two entries to the existing
// "rewrites" array alongside the /api/x-token and /api/x-api ones — don't
// replace the file, just add to the array):
//   { "source": "/api/facebook-token", "destination": "/api/facebook" },
//   { "source": "/api/facebook-graph", "destination": "/api/facebook" }
//
// REQUIRED VERCEL ENV VARS: unchanged — still just FACEBOOK_CLIENT_SECRET
// (Settings -> Environment Variables). FACEBOOK_APP_ID is not secret and
// stays hardcoded below, same as before.

const FACEBOOK_APP_ID = '1037570602213729';
const FACEBOOK_APP_SECRET = process.env.FACEBOOK_CLIENT_SECRET;
// Bumped from v21.0 (Oct 2024) — that old a version was silently returning
// empty {data:[]} for /{page-id}/posts against a token that Facebook's own
// Access Token Debugger confirmed DID carry pages_read_engagement (and
// which worked fine against the identical Page/token combo when tested
// through Graph API Explorer, which defaults to a current version).
// Confirmed live: a Business-Manager-owned Page's /posts edge behaves
// differently enough across versions that the old pin was the actual root
// cause of a long-standing "(#10) pages_read_engagement" error on the
// Analytics tab's Recent Posts, even with the permission properly granted
// and the app connected to the Page as a Business Asset.
const GRAPH_VERSION = 'v23.0';

// Exchanges a Facebook OAuth authorization code for an access token,
// without exposing the App Secret to the browser. Facebook's code->token
// exchange returns a short-lived token (~1-2 hours); a second call
// (grant_type=fb_exchange_token) trades it for a long-lived one (~60
// days). Both hops need the App Secret, so both happen here server-side —
// the browser only ever sees the final long-lived token.
async function handleTokenExchange(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  if (!FACEBOOK_APP_SECRET) {
    res.status(500).json({ error: 'server_misconfigured', error_description: 'FACEBOOK_CLIENT_SECRET environment variable is not set' });
    return;
  }

  try {
    const body = req.body || {};
    const code = body.code;
    const redirectUri = body.redirect_uri;
    if (!code || !redirectUri) {
      res.status(400).json({ error: 'invalid_request', error_description: 'Provide "code" and "redirect_uri"' });
      return;
    }

    const shortParams = new URLSearchParams();
    shortParams.set('client_id', FACEBOOK_APP_ID);
    shortParams.set('client_secret', FACEBOOK_APP_SECRET);
    shortParams.set('code', code);
    shortParams.set('redirect_uri', redirectUri);

    const shortResp = await fetch('https://graph.facebook.com/' + GRAPH_VERSION + '/oauth/access_token?' + shortParams.toString());
    const shortData = await shortResp.json();
    if (!shortResp.ok || !shortData.access_token) {
      res.status(shortResp.status).json(shortData);
      return;
    }

    const longParams = new URLSearchParams();
    longParams.set('grant_type', 'fb_exchange_token');
    longParams.set('client_id', FACEBOOK_APP_ID);
    longParams.set('client_secret', FACEBOOK_APP_SECRET);
    longParams.set('fb_exchange_token', shortData.access_token);

    const longResp = await fetch('https://graph.facebook.com/' + GRAPH_VERSION + '/oauth/access_token?' + longParams.toString());
    const longData = await longResp.json();
    if (!longResp.ok || !longData.access_token) {
      // Fall back to the short-lived token rather than failing outright —
      // still usable, just expires sooner.
      res.status(200).json(shortData);
      return;
    }

    res.status(200).json(longData);
  } catch (err) {
    res.status(500).json({ error: 'server_error', error_description: String(err && err.message ? err.message : err) });
  }
}

// Relays Facebook Graph API GET/POST calls, adding CORS headers. No secret
// involved — the caller's own access token (already in the browser) is
// forwarded as-is. Exists defensively: several Graph API endpoints
// (particularly under /act_{ad_account_id}/...) don't reliably send
// Access-Control-Allow-Origin for direct browser fetches.
async function handleGraphRelay(req, res) {
  const path = req.query.path;
  if (!path || typeof path !== 'string' || !path.startsWith('/')) {
    res.status(400).json({ error: { message: 'Provide a "path" query param starting with "/", e.g. ?path=/act_123/campaigns' } });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.status(401).json({ error: { message: 'Provide an Authorization: Bearer <token> header' } });
    return;
  }

  try {
    const url = 'https://graph.facebook.com/' + GRAPH_VERSION + path;

    if (req.method === 'GET') {
      const qs = new URLSearchParams(req.query);
      qs.delete('path');
      const sep = qs.toString() ? '?' + qs.toString() : '';
      const fbResponse = await fetch(url + sep, {
        method: 'GET',
        headers: { Authorization: authHeader }
      });
      const fbData = await fbResponse.json();
      res.status(fbResponse.status).json(fbData);
      return;
    }

    if (req.method === 'POST') {
      const fbResponse = await fetch(url, {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body || {})
      });
      const fbData = await fbResponse.json();
      res.status(fbResponse.status).json(fbData);
      return;
    }

    res.status(405).json({ error: { message: 'method_not_allowed' } });
  } catch (err) {
    res.status(500).json({ error: { message: String(err && err.message ? err.message : err) } });
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // index.html always calls the Graph relay as ?path=..., and never sends
  // a path param when exchanging a token — that alone is enough to route
  // between the two halves without a method check.
  if (req.query.path) { await handleGraphRelay(req, res); return; }
  await handleTokenExchange(req, res);
};
