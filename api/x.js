// Miles Man CRM — X (Twitter) OAuth 2.0 token exchange/refresh AND API v2
// CORS relay, merged into one file.
//
// WHY MERGED: Vercel's Hobby (free) plan caps a deployment at 12 Serverless
// Functions. This project already hit that cap once before (that's why
// api/canva.js is one file instead of the two it started as). Adding
// x-token.js + x-api.js as two separate files trips the same limit, so
// they're combined here into a single function instead.
//
// WHERE THIS GOES: copy to api/x.js in the milesman-auth Vercel project
// (C:\Users\ericl\milesman-auth-fix). index.html's own calling code still
// hits the two original URLs (/api/x-token, /api/x-api) unchanged — a
// vercel.json rewrite (see below) routes both of those paths to this one
// file, so no index.html changes are needed. Deploy with `vercel --prod`
// from that folder.
//
// REQUIRED vercel.json rewrites (create the file if the project doesn't
// have one yet; if it already has a "rewrites" array for something else,
// add these two entries to it rather than replacing the file):
//   {
//     "rewrites": [
//       { "source": "/api/x-token", "destination": "/api/x" },
//       { "source": "/api/x-api", "destination": "/api/x" }
//     ]
//   }
//
// REQUIRED VERCEL ENV VARS (Project Settings -> Environment Variables):
//   X_CLIENT_ID      — OAuth 2.0 Client ID from the X Developer Portal
//   X_CLIENT_SECRET  — OAuth 2.0 Client Secret from the same app
//
// Also set X_CLIENT_ID (the same value — it isn't secret) in index.html's
// X_CLIENT_ID constant, which is currently blank.
//
// X SETUP (developer.x.com -> your Project -> your App -> User authentication settings):
//   - App permissions: Read
//   - Type of App: Web App, Automated App or Bot   <- this is what makes it a
//     confidential client and gives you a Client Secret; a "Native App" is a
//     public client with no secret and won't work with this endpoint
//   - Callback URI: https://milesmaneric.github.io/milesman-crm/
//   - Website URL: https://themilesman.com/
//
// COST: X has no usable free tier as of Feb 2026 — reads are billed
// per request (~$0.010 for a user-scoped read like /2/users/me). The CRM
// caches one snapshot per calendar day to keep this to roughly one read
// per day. Adding a payment method in the X Developer Portal is required
// before any read will succeed.

const TOKEN_URL = 'https://api.x.com/2/oauth2/token';
const ALLOWED_API_PREFIXES = ['/2/users/me', '/2/users/', '/2/tweets'];

// Handles the OAuth token exchange/refresh — index.html's own calling code
// (getXAccessToken()/xLogin()'s redirect handler) always POSTs here.
async function handleTokenExchange(req, res) {
  const clientId = process.env.X_CLIENT_ID;
  const clientSecret = process.env.X_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    res.status(500).json({ error: 'server_not_configured', error_description: 'X_CLIENT_ID / X_CLIENT_SECRET are not set on this Vercel project.' });
    return;
  }

  const body = req.body || {};
  let form;

  if (body.grant_type === 'refresh_token') {
    if (!body.refresh_token) { res.status(400).json({ error: 'missing_refresh_token' }); return; }
    form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: body.refresh_token,
      client_id: clientId
    });
  } else {
    if (!body.code || !body.redirect_uri || !body.code_verifier) {
      res.status(400).json({ error: 'missing_params', error_description: 'code, redirect_uri and code_verifier are all required.' });
      return;
    }
    form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: body.code,
      redirect_uri: body.redirect_uri,
      code_verifier: body.code_verifier,
      client_id: clientId
    });
  }

  try {
    // X requires HTTP Basic auth on the token endpoint for confidential
    // clients (an app created as "Web App, Automated App or Bot"), even
    // though client_id is also in the form body.
    const basic = Buffer.from(clientId + ':' + clientSecret).toString('base64');
    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + basic
      },
      body: form.toString()
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); }
    catch (e) { data = { error: 'bad_response', error_description: text.slice(0, 500) }; }
    // Pass X's own status through — a 401 here almost always means the
    // App type is wrong (Native App instead of Web App, so no secret) or
    // the secret was regenerated in the Developer Portal without updating
    // the X_CLIENT_SECRET env var here.
    res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: 'proxy_error', error_description: e.message });
  }
}

// Handles the CORS relay to api.x.com — index.html's own calling code
// (xApi()) always GETs here with ?path=... and its own X user access token
// in the Authorization header. No secret lives in this half at all.
async function handleApiRelay(req, res) {
  const auth = req.headers.authorization;
  if (!auth) { res.status(401).json({ error: 'missing_authorization' }); return; }

  const path = req.query.path;
  if (!path) { res.status(400).json({ error: 'missing_path' }); return; }

  // Only relay read endpoints this app actually uses — keeps a leaked or
  // borrowed token from being able to drive arbitrary (billable, or
  // write) X API calls through this proxy.
  if (!ALLOWED_API_PREFIXES.some(p => path.startsWith(p))) {
    res.status(403).json({ error: 'path_not_allowed', error_description: 'This relay only serves X read endpoints used by the CRM.' });
    return;
  }

  // Everything except ?path= is forwarded to X as-is (e.g. user.fields=...).
  const params = new URLSearchParams();
  Object.keys(req.query).forEach(k => { if (k !== 'path') params.append(k, req.query[k]); });
  const qs = params.toString();
  const url = 'https://api.x.com' + path + (qs ? '?' + qs : '');

  try {
    const r = await fetch(url, { headers: { Authorization: auth } });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); }
    catch (e) { data = { error: 'bad_response', error_description: text.slice(0, 500) }; }
    // Pass X's status through rather than flattening to 200 — a 429 is
    // rate limiting, a 403 usually means the app lacks the scope or no
    // payment method is on file, and the CRM surfaces those messages
    // verbatim so the real cause is visible.
    res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: 'proxy_error', error_description: e.message });
  }
}

module.exports = async (req, res) => {
  // The CRM is served from GitHub Pages, a different origin than this
  // proxy, so the browser preflights both POST (token exchange) and GET
  // (API relay) requests here.
  res.setHeader('Access-Control-Allow-Origin', 'https://milesmaneric.github.io');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // The two original endpoints never shared a method — token exchange is
  // always POST, the API relay always GET — so that alone is enough to
  // route between them without needing a query param of its own.
  if (req.method === 'POST') { await handleTokenExchange(req, res); return; }
  if (req.method === 'GET') { await handleApiRelay(req, res); return; }

  res.status(405).json({ error: 'method_not_allowed' });
};
