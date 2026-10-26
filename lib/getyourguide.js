// Vercel serverless function: secure server-side proxy for the GetYourGuide
// Partner API. Mirrors the existing proxy pattern used by /api/canva etc. —
// the real GetYourGuide API key lives only in this project's Vercel
// Environment Variables (GETYOURGUIDE_API_KEY), never in the CRM's
// client-side code.

const GYG_API_BASE = 'https://api.getyourguide.com';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.GETYOURGUIDE_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'GETYOURGUIDE_API_KEY is not configured on the server' });
    return;
  }

  // "service" is the internal dispatch flag set by api/mailchimp.js's rewrite;
  // it must not be forwarded to GetYourGuide.
  const { path, service, ...rest } = req.query || {};
  if (!path || typeof path !== 'string' || !path.startsWith('/')) {
    res.status(400).json({ error: 'Missing or invalid "path" query parameter (must start with /)' });
    return;
  }

  const upstreamUrl = new URL(GYG_API_BASE + path);
  Object.keys(rest).forEach((key) => {
    const val = rest[key];
    if (Array.isArray(val)) {
      val.forEach((v) => upstreamUrl.searchParams.append(key, v));
    } else if (val !== undefined) {
      upstreamUrl.searchParams.append(key, val);
    }
  });

  try {
    const upstreamRes = await fetch(upstreamUrl.toString(), {
      method: 'GET',
      headers: {
        'X-ACCESS-TOKEN': apiKey,
        'Accept': 'application/json'
      }
    });
    const body = await upstreamRes.text();
    res.status(upstreamRes.status);
    res.setHeader('Content-Type', upstreamRes.headers.get('content-type') || 'application/json');
    res.send(body);
  } catch (err) {
    res.status(502).json({ error: 'Upstream GetYourGuide request failed', detail: err.message });
  }
};
