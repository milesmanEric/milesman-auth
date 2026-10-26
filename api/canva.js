// api/canva.js
// Vercel serverless function: merged replacement for the former
// api/canva-token.js + api/canva-api.js — combined into one file purely to
// stay under Vercel Hobby's 12-serverless-functions-per-deployment cap
// (the same reason canva-api.js's own "/x-export-full" pseudo-path exists
// instead of a separate api/canva-export.js). No behavior changed from the
// two original files, just dispatched from one entry point instead of two.
//
// Dispatch is on the "path" query param, same convention every other
// *-api.js relay in this project already uses:
//   ?path=/x-token         -> OAuth token exchange / refresh (was
//                              api/canva-token.js's entire job)
//   ?path=/x-export-full   -> full create-job/poll/download/base64 export
//                              dance (unchanged from api/canva-api.js)
//   ?path=<anything else>  -> plain Canva Connect API relay (unchanged from
//                              api/canva-api.js)
// "/x-token" and "/x-export-full" are both deliberately outside Canva's own
// resource namespace (which never starts with "/x-"), so neither can ever
// collide with a real Canva API path.
//
// ── OAuth / PKCE (was api/canva-token.js) ──────────────────────────────
// Canva's OAuth flow requires PKCE (code_verifier/code_challenge) on top of
// the usual client_id/client_secret — the code_verifier is generated and
// held client-side (it never touches this server) and is only sent here
// once, alongside the authorization code, to prove this exchange came from
// the same browser that started the flow.
//
// Unlike Facebook's ~60-day long-lived token, Canva's access token is only
// valid ~4 hours, so ?path=/x-token also handles grant_type=refresh_token —
// the CRM calls back here with the stored refresh_token whenever the access
// token is close to/past expiry, same shape response either way.
//
// CANVA_CLIENT_ID isn't a secret — it's the same public value already
// hardcoded as CANVA_CLIENT_ID in index.html for the browser-side redirect,
// so it's hardcoded here too rather than read from an env var (same
// treatment FACEBOOK_APP_ID gets in api/facebook-token.js). Only the secret
// needs to be kept out of the browser and set in Vercel:
//   CANVA_CLIENT_SECRET   (Settings -> Environment Variables)
//
// ── API relay (was api/canva-api.js) ───────────────────────────────────
// Relays Canva Connect API GET/POST calls, adding CORS headers. No secret
// involved here — the caller's own access token (already in the browser)
// is forwarded as-is. Exists because Canva's Connect API explicitly blocks
// direct browser fetches for any authenticated call (confirmed in their own
// CORS docs) — every call has to come from a backend, not just the token
// exchange.

const CANVA_CLIENT_ID = 'OC-AaAU8P8p6wvR';
const CANVA_CLIENT_SECRET = process.env.CANVA_CLIENT_SECRET;
const TOKEN_URL = 'https://api.canva.com/rest/v1/oauth/token';
const API_BASE = 'https://api.canva.com/rest/v1';
const POLL_INTERVAL_MS = 1500;
const MAX_POLLS = 16; // ~24s total, generously above Canva's documented "a few seconds"

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function handleTokenExchange(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  if (!CANVA_CLIENT_SECRET) {
    res.status(500).json({ error: 'server_misconfigured', error_description: 'CANVA_CLIENT_SECRET must be set in Vercel env vars' });
    return;
  }

  try {
    const body = req.body || {};
    const params = new URLSearchParams();

    if (body.grant_type === 'refresh_token') {
      if (!body.refresh_token) {
        res.status(400).json({ error: 'invalid_request', error_description: 'Provide "refresh_token"' });
        return;
      }
      params.set('grant_type', 'refresh_token');
      params.set('refresh_token', body.refresh_token);
    } else {
      const code = body.code;
      const redirectUri = body.redirect_uri;
      const codeVerifier = body.code_verifier;
      if (!code || !redirectUri || !codeVerifier) {
        res.status(400).json({ error: 'invalid_request', error_description: 'Provide "code", "redirect_uri", and "code_verifier"' });
        return;
      }
      params.set('grant_type', 'authorization_code');
      params.set('code', code);
      params.set('redirect_uri', redirectUri);
      params.set('code_verifier', codeVerifier);
    }

    const basicAuth = Buffer.from(CANVA_CLIENT_ID + ':' + CANVA_CLIENT_SECRET).toString('base64');
    const tokenResp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + basicAuth,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
    const tokenData = await tokenResp.json();
    res.status(tokenResp.status).json(tokenData);
  } catch (err) {
    res.status(500).json({ error: 'server_error', error_description: String(err && err.message ? err.message : err) });
  }
}

async function handleExportFull(req, res, authHeader) {
  const designId = (req.body || {}).design_id;
  if (!designId) {
    res.status(400).json({ error: { message: 'Provide "design_id"' } });
    return;
  }

  const createResp = await fetch(API_BASE + '/exports', {
    method: 'POST',
    headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ design_id: designId, format: { type: 'png' } })
  });
  // Canva's error shape here is a flat {code, message}, not Facebook-style
  // {error:{message}} — read createData.message directly rather than
  // createData.error.message (which would always be undefined).
  const createData = await createResp.json();
  if (!createResp.ok || !createData.job || !createData.job.id) {
    res.status(createResp.status || 500).json({ error: { message: createData.message || 'Failed to create export job' } });
    return;
  }

  const jobId = createData.job.id;
  let job = createData.job;
  let polls = 0;
  while (job.status === 'in_progress' && polls < MAX_POLLS) {
    await sleep(POLL_INTERVAL_MS);
    polls++;
    const pollResp = await fetch(API_BASE + '/exports/' + jobId, { headers: { Authorization: authHeader } });
    const pollData = await pollResp.json();
    if (!pollResp.ok || !pollData.job) {
      res.status(pollResp.status || 500).json({ error: { message: pollData.message || 'Failed to check export job status' } });
      return;
    }
    job = pollData.job;
  }

  if (job.status !== 'success') {
    res.status(504).json({ error: { message: job.status === 'in_progress' ? 'Export timed out — try again' : ('Export failed: ' + (job.error && job.error.message ? job.error.message : job.status)) } });
    return;
  }

  const fileUrl = job.urls && job.urls[0];
  if (!fileUrl) {
    res.status(500).json({ error: { message: 'Export succeeded but no download URL was returned' } });
    return;
  }

  const fileResp = await fetch(fileUrl);
  if (!fileResp.ok) {
    res.status(502).json({ error: { message: 'Failed to download exported image (status ' + fileResp.status + ')' } });
    return;
  }
  const arrayBuffer = await fileResp.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');
  res.status(200).json({ dataUrl: 'data:image/png;base64,' + base64 });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const path = req.query.path;
  if (!path || typeof path !== 'string' || !path.startsWith('/')) {
    res.status(400).json({ error: { message: 'Provide a "path" query param starting with "/", e.g. ?path=/designs or ?path=/x-token' } });
    return;
  }

  // Token exchange/refresh needs no Authorization header (there's no
  // access token yet, or the caller is refreshing a stale one) — handle it
  // before the relay branch below, which requires one.
  if (path === '/x-token') {
    await handleTokenExchange(req, res);
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.status(401).json({ error: { message: 'Provide an Authorization: Bearer <token> header' } });
    return;
  }

  try {
    if (path === '/x-export-full') {
      if (req.method !== 'POST') { res.status(405).json({ error: { message: 'method_not_allowed' } }); return; }
      await handleExportFull(req, res, authHeader);
      return;
    }

    const url = API_BASE + path;

    // Canva's own error shape is a flat {code, message} at the top level —
    // nothing like Facebook's nested {error:{message}}, which is the shape
    // every other error-handling call site in this app already expects.
    // Normalizing it here (only on a non-2xx response, so a real successful
    // payload that happens to have its own "code"/"message" fields — e.g. an
    // export job — passes through untouched) means canvaApi() callers can
    // check resp.error the same way fbGraph() callers already do, instead
    // of needing to know which raw shape each individual Canva endpoint uses.
    function normalizeError(status, data) {
      if (status >= 200 && status < 300) return data;
      if (data && data.error) return data;
      return Object.assign({}, data, { error: { message: (data && data.message) || 'Request failed', code: data && data.code } });
    }

    if (req.method === 'GET') {
      const qs = new URLSearchParams(req.query);
      qs.delete('path');
      const sep = qs.toString() ? '?' + qs.toString() : '';
      const cvResponse = await fetch(url + sep, {
        method: 'GET',
        headers: { Authorization: authHeader }
      });
      const cvData = await cvResponse.json();
      res.status(cvResponse.status).json(normalizeError(cvResponse.status, cvData));
      return;
    }

    if (req.method === 'POST') {
      const cvResponse = await fetch(url, {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body || {})
      });
      const cvData = await cvResponse.json();
      res.status(cvResponse.status).json(normalizeError(cvResponse.status, cvData));
      return;
    }

    res.status(405).json({ error: { message: 'method_not_allowed' } });
  } catch (err) {
    res.status(500).json({ error: { message: String(err && err.message ? err.message : err) } });
  }
};
