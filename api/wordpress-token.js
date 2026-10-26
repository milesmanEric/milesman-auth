// api/wordpress-token.js
// Vercel serverless function: exchanges a WordPress.com OAuth2 authorization
// code for an access token, without exposing the Client Secret to the
// browser. Same pattern as api/drive-token.js.
//
// Unlike Google's Drive OAuth flow, WordPress.com's Authorization Code
// Grant response has no refresh_token (see
// https://developer.wordpress.com/docs/oauth2/) — its access tokens aren't
// documented as expiring the way Implicit Flow tokens do, so there's no
// refresh_token grant type to support here. If a token ever does stop
// working, the fix is just sending the user through /oauth2/authorize
// again, not refreshing.

const WORDPRESS_CLIENT_ID = '145675';
// IMPORTANT: set this in Vercel's Environment Variables (Settings -> Environment Variables)
// Name: WORDPRESS_CLIENT_SECRET
const WORDPRESS_CLIENT_SECRET = process.env.WORDPRESS_CLIENT_SECRET;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  if (!WORDPRESS_CLIENT_SECRET) {
    res.status(500).json({ error: 'server_misconfigured', error_description: 'WORDPRESS_CLIENT_SECRET environment variable is not set' });
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

    const params = new URLSearchParams();
    params.set('client_id', WORDPRESS_CLIENT_ID);
    params.set('client_secret', WORDPRESS_CLIENT_SECRET);
    params.set('code', code);
    params.set('grant_type', 'authorization_code');
    params.set('redirect_uri', redirectUri);

    const wpResponse = await fetch('https://public-api.wordpress.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    const wpData = await wpResponse.json();
    res.status(wpResponse.status).json(wpData);
  } catch (err) {
    res.status(500).json({ error: 'server_error', error_description: String(err && err.message ? err.message : err) });
  }
};
