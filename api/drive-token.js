// api/drive-token.js
// Vercel serverless function: securely exchanges a Google authorization code (or refresh token)
// for a Google Drive access token, without exposing the client secret to the browser.

const DRIVE_CLIENT_ID = '1055867383042-an9l58o1qg22pt7o4ak8vaneeftv54ib.apps.googleusercontent.com';
// IMPORTANT: set this in Vercel's Environment Variables (Settings -> Environment Variables)
// Name: GOOGLE_CLIENT_SECRET
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

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

  if (!GOOGLE_CLIENT_SECRET) {
    res.status(500).json({ error: 'server_misconfigured', error_description: 'GOOGLE_CLIENT_SECRET environment variable is not set' });
    return;
  }

  try {
    const body = req.body || {};
    const grantType = body.grant_type;

    const tokenUrl = 'https://oauth2.googleapis.com/token';

    const params = new URLSearchParams();
    params.set('client_id', DRIVE_CLIENT_ID);
    params.set('client_secret', GOOGLE_CLIENT_SECRET);

    if (grantType === 'authorization_code') {
      params.set('grant_type', 'authorization_code');
      params.set('code', body.code);
      params.set('redirect_uri', body.redirect_uri);
      params.set('code_verifier', body.code_verifier);
    } else if (grantType === 'refresh_token') {
      params.set('grant_type', 'refresh_token');
      params.set('refresh_token', body.refresh_token);
    } else {
      res.status(400).json({ error: 'invalid_grant_type', error_description: 'grant_type must be authorization_code or refresh_token' });
      return;
    }

    const googleResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    const googleData = await googleResponse.json();

    if (!googleResponse.ok) {
      res.status(googleResponse.status).json(googleData);
      return;
    }

    res.status(200).json(googleData);
  } catch (err) {
    res.status(500).json({ error: 'server_error', error_description: String(err && err.message ? err.message : err) });
  }
};