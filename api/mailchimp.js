// api/mailchimp.js
// Vercel serverless function: proxies Mailchimp Marketing API requests so
// the browser never needs Mailchimp's API key directly. Mailchimp's API does
// not send CORS headers, so the milesman-crm static app can't call it
// directly from client-side JS — this holds the key server-side and
// forwards whatever Mailchimp API path the client asks for.
//
// PUT is included alongside GET specifically for the "add or update list
// member" endpoint (/lists/{id}/members/{subscriber_hash}), which is how
// new CRM subscribers get synced into Mailchimp — Mailchimp's own upsert
// semantics for that endpoint, not something reimplemented here.
//
// IMPORTANT: set MAILCHIMP_API_KEY in Vercel's Environment Variables
// (Settings -> Environment Variables). The key's data-center suffix
// (e.g. "-us21") is used to build the API host, so no separate DC env var
// is needed.

const MAILCHIMP_API_KEY = process.env.MAILCHIMP_API_KEY;

// WHY GETYOURGUIDE LIVES HERE: Vercel's Hobby plan caps a deployment at 12
// serverless functions and api/ is already at 12, so the GetYourGuide Partner
// API proxy (lib/getyourguide.js, not under api/, so it isn't a function of
// its own) is dispatched from this file. vercel.json rewrites /api/getyourguide
// to /api/mailchimp?service=getyourguide. Needs GETYOURGUIDE_API_KEY in Vercel.
const getyourguideHandler = require('../lib/getyourguide');

module.exports = async function handler(req, res) {
  if (req.query && req.query.service === 'getyourguide') {
    return getyourguideHandler(req, res);
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'PUT') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  if (!MAILCHIMP_API_KEY) {
    res.status(500).json({ error: 'server_misconfigured', error_description: 'MAILCHIMP_API_KEY environment variable is not set' });
    return;
  }

  const dc = MAILCHIMP_API_KEY.split('-').pop();
  if (!dc) {
    res.status(500).json({ error: 'server_misconfigured', error_description: 'MAILCHIMP_API_KEY is missing its data-center suffix (expected format: <hash>-usXX)' });
    return;
  }

  const path = req.query.path;
  if (!path || typeof path !== 'string' || !path.startsWith('/')) {
    res.status(400).json({ error: 'invalid_path', error_description: 'Provide a "path" query param starting with "/", e.g. ?path=/lists' });
    return;
  }

  try {
    const url = 'https://' + dc + '.api.mailchimp.com/3.0' + path;
    const auth = Buffer.from('anystring:' + MAILCHIMP_API_KEY).toString('base64');

    const fetchOpts = {
      method: req.method,
      headers: { Authorization: 'Basic ' + auth }
    };
    if (req.method === 'PUT') {
      fetchOpts.headers['Content-Type'] = 'application/json';
      fetchOpts.body = JSON.stringify(req.body || {});
    }

    const mcResponse = await fetch(url, fetchOpts);
    const mcData = await mcResponse.json();
    res.status(mcResponse.status).json(mcData);
  } catch (err) {
    res.status(500).json({ error: 'server_error', error_description: String(err && err.message ? err.message : err) });
  }
};
