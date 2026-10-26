// api/token.js
// Vercel serverless function: exchanges an authorization code (or refresh token)
// for a Microsoft Graph access token. This app is registered as a PUBLIC client
// in Azure AD, so no client_secret is used - PKCE (code_verifier) provides security.

const MS_CLIENT_ID = 'f59cebe9-632b-4361-bdab-71dda33c174c';
const MS_TENANT_ID = 'a9346e69-975d-4abb-861a-dea6e2464642';

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

  try {
    const body = req.body || {};
    const grantType = body.grant_type;

    const tokenUrl = 'https://login.microsoftonline.com/' + MS_TENANT_ID + '/oauth2/v2.0/token';

    const params = new URLSearchParams();
    params.set('client_id', MS_CLIENT_ID);

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

    const msResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    const msData = await msResponse.json();

    if (!msResponse.ok) {
      res.status(msResponse.status).json(msData);
      return;
    }

    res.status(200).json(msData);
  } catch (err) {
    res.status(500).json({ error: 'server_error', error_description: String(err && err.message ? err.message : err) });
  }
};