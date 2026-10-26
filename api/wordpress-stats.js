// api/wordpress-stats.js
// Vercel serverless function: proxies WordPress.com REST API GET requests
// purely to add CORS headers — public-api.wordpress.com doesn't send any,
// so the browser can't call it directly even with a valid bearer token the
// client already legitimately holds (obtained via api/wordpress-token.js).
// Unlike that endpoint, there's no secret to protect here — this is just a
// CORS-friendly relay, so it forwards whatever Authorization header the
// caller sends straight through, the same way api/mailchimp.js forwards a
// caller-supplied `path` query param.
//
// Also handles ?site=1, which switches this same relay to themilesman.com's
// own public WordPress REST API (wp-json) instead of the WordPress.com
// stats API — folded in here rather than kept as its own
// api/wordpress-site-rest.js file to stay under Vercel Hobby's
// 12-serverless-functions-per-deployment cap. That target needs no auth at
// all (it's public data; self-hosted WordPress just doesn't send CORS
// headers either), and the site domain is hardcoded, not caller-supplied,
// so it can't be used as an open proxy to fetch arbitrary URLs.

const WP_SITE = 'themilesman.com';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const path = req.query.path;
  if (!path || typeof path !== 'string' || !path.startsWith('/')) {
    res.status(400).json({ error: 'invalid_path', error_description: 'Provide a "path" query param starting with "/", e.g. ?path=/sites/example.com/stats' });
    return;
  }

  if (req.query.site) {
    try {
      const qs = new URLSearchParams(req.query);
      qs.delete('path');
      qs.delete('site');
      const sep = qs.toString() ? '?' + qs.toString() : '';
      const url = 'https://' + WP_SITE + '/wp-json' + path + sep;
      const wpResponse = await fetch(url, { method: 'GET' });
      const wpData = await wpResponse.json();
      res.status(wpResponse.status).json(wpData);
    } catch (err) {
      res.status(500).json({ error: 'server_error', error_description: String(err && err.message ? err.message : err) });
    }
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.status(401).json({ error: 'missing_authorization', error_description: 'Provide an Authorization: Bearer <token> header' });
    return;
  }

  try {
    const url = 'https://public-api.wordpress.com/rest/v1.1' + path;
    const wpResponse = await fetch(url, {
      method: 'GET',
      headers: { Authorization: authHeader }
    });
    const wpData = await wpResponse.json();
    res.status(wpResponse.status).json(wpData);
  } catch (err) {
    res.status(500).json({ error: 'server_error', error_description: String(err && err.message ? err.message : err) });
  }
};
