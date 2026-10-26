// api/secure-sync.js
// Server-verified alternative to the CRM's client-side password gate + direct
// Drive backup/restore. The browser sends a Google ID token (not a Drive
// access token); this endpoint verifies it against Google directly and
// checks the email against an allowlist BEFORE touching any data — the
// browser itself never holds a credential capable of reading/writing the
// backup file on this path. The server uses its own stored Drive refresh
// token (a real one-time OAuth grant from an allowed account, saved as a
// Vercel env var) to read/write the SAME milesman-crm-backup.json file the
// existing client-side Backup/Restore buttons already use, so both paths
// stay interchangeable — this is additive, not a replacement.
//
// Required Vercel env vars (Settings -> Environment Variables):
//   GOOGLE_CLIENT_SECRET      (already set for drive-token.js)
//   DRIVE_SERVER_REFRESH_TOKEN  a Drive refresh token for the allowed
//                               Google account (see CRM's "Copy Drive Refresh
//                               Token" debug button for how to get this)
//   ALLOWED_EMAILS              comma-separated list, e.g. "you@gmail.com"
//
// Also handles ?action=sms-incoming (folded in here, not its own file, to
// stay under Vercel Hobby's 12-serverless-functions cap) — the receiving
// end for an Android SMS-forwarding app (e.g. "SMS Forwarder" by
// frzinapps), configured to POST each incoming text here. That path uses
// a completely different, simpler auth than the rest of this file (a
// static shared secret in the Authorization header, not a Google ID
// token — the phone has no Google session to present) and writes to its
// own queue file on the same Drive account, using the same server-side
// Drive credentials already set up above. The CRM reads that queue file
// back out directly with the user's own already-connected Drive token
// (no server round-trip needed for that side) and clears it after
// logging each message as a client note.
//   SMS_WEBHOOK_SECRET          a secret you make up, entered as the
//                               Authorization: Bearer value in the phone
//                               app's request headers

const DRIVE_CLIENT_ID = '1055867383042-an9l58o1qg22pt7o4ak8vaneeftv54ib.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const DRIVE_SERVER_REFRESH_TOKEN = process.env.DRIVE_SERVER_REFRESH_TOKEN;
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || '')
  .split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
const BACKUP_FILENAME = 'milesman-crm-backup.json';
const SMS_WEBHOOK_SECRET = process.env.SMS_WEBHOOK_SECRET;
const SMS_QUEUE_FILENAME = 'milesman-sms-queue.json';

async function verifyIdToken(idToken) {
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
  const data = await r.json();
  if (!r.ok) throw new Error('invalid_id_token: ' + (data.error_description || data.error || r.status));
  if (data.aud !== DRIVE_CLIENT_ID) throw new Error('wrong_audience');
  if (data.email_verified !== 'true' && data.email_verified !== true) throw new Error('email_not_verified');
  const email = (data.email || '').toLowerCase();
  if (!ALLOWED_EMAILS.includes(email)) throw new Error('email_not_allowed: ' + email);
  return email;
}

async function getServerDriveAccessToken() {
  const params = new URLSearchParams();
  params.set('client_id', DRIVE_CLIENT_ID);
  params.set('client_secret', GOOGLE_CLIENT_SECRET);
  params.set('grant_type', 'refresh_token');
  params.set('refresh_token', DRIVE_SERVER_REFRESH_TOKEN);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  const data = await r.json();
  if (!r.ok) throw new Error('drive_refresh_failed: ' + (data.error_description || data.error));
  return data.access_token;
}

async function findBackupFile(accessToken, filename) {
  const q = encodeURIComponent("name='" + (filename || BACKUP_FILENAME) + "' and trashed=false");
  const r = await fetch('https://www.googleapis.com/drive/v3/files?q=' + q + '&fields=files(id,name,modifiedTime)', {
    headers: { Authorization: 'Bearer ' + accessToken }
  });
  const data = await r.json();
  if (!r.ok) throw new Error('drive_list_failed: ' + r.status);
  return (data.files && data.files[0]) || null;
}

async function writeDriveJsonFile(accessToken, filename, obj) {
  const content = JSON.stringify(obj);
  const existing = await findBackupFile(accessToken, filename);
  if (existing) {
    const r = await fetch('https://www.googleapis.com/upload/drive/v3/files/' + existing.id + '?uploadType=media&fields=id', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: content
    });
    if (!r.ok) throw new Error('drive_write_failed: ' + r.status);
    return;
  }
  const boundary = 'sms_queue_' + Date.now();
  const metadata = JSON.stringify({ name: filename, mimeType: 'application/json' });
  const multipartBody =
    '--' + boundary + '\r\n' +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' + metadata + '\r\n' +
    '--' + boundary + '\r\n' +
    'Content-Type: application/json\r\n\r\n' + content + '\r\n' +
    '--' + boundary + '--';
  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'multipart/related; boundary=' + boundary },
    body: multipartBody
  });
  if (!r.ok) throw new Error('drive_create_failed: ' + r.status);
}

async function handleSmsIncoming(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error_code: 1, error: 'method_not_allowed' }); return; }
  if (!SMS_WEBHOOK_SECRET || !GOOGLE_CLIENT_SECRET || !DRIVE_SERVER_REFRESH_TOKEN) {
    res.status(500).json({ error_code: 1, error: 'server_misconfigured' });
    return;
  }
  // SMSGate (the android-sms-gateway app) can't send a custom Authorization
  // header on its webhook POSTs, so the secret travels in the URL's query
  // string instead — it's baked into the webhook URL at registration time.
  // Still accept a Bearer header too, for manual/curl testing.
  const authHeader = req.headers.authorization || '';
  const headerSecret = authHeader.replace(/^Bearer\s+/i, '');
  const secret = headerSecret || (req.query.secret || '');
  if (secret !== SMS_WEBHOOK_SECRET) { res.status(401).json({ error_code: 1, error: 'unauthorized' }); return; }

  const body = req.body || {};
  // SMSGate's sms:received payload nests the actual message under
  // body.payload ({sender, message, receivedAt}); a plain {from, text}
  // body (e.g. from a manual curl test) is accepted directly too.
  const src = (body.event === 'sms:received' && body.payload) ? body.payload : body;
  const from = (src.sender || src.from || '').toString().trim();
  const text = (src.message || src.text || '').toString();
  if (!from || !text) { res.status(400).json({ error_code: 1, error: 'invalid_body', error_description: 'Expected SMSGate sms:received payload or {from, text}' }); return; }

  try {
    const driveToken = await getServerDriveAccessToken();
    const existingFile = await findBackupFile(driveToken, SMS_QUEUE_FILENAME);
    let queue = [];
    if (existingFile) {
      const r = await fetch('https://www.googleapis.com/drive/v3/files/' + existingFile.id + '?alt=media', {
        headers: { Authorization: 'Bearer ' + driveToken }
      });
      if (r.ok) {
        try { queue = JSON.parse(await r.text()); if (!Array.isArray(queue)) queue = []; } catch (e) { queue = []; }
      }
    }
    // Capped so a runaway/looping forwarder can't grow this file forever
    // between CRM syncs — oldest entries drop first.
    queue.push({ from: from, text: text, receivedAt: src.receivedAt || new Date().toISOString() });
    if (queue.length > 500) queue = queue.slice(queue.length - 500);
    await writeDriveJsonFile(driveToken, SMS_QUEUE_FILENAME, queue);
    res.status(200).json({ error_code: 0 });
  } catch (err) {
    res.status(500).json({ error_code: 1, error: 'server_error', error_description: String(err && err.message ? err.message : err) });
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  if (req.query.action === 'sms-incoming') {
    await handleSmsIncoming(req, res);
    return;
  }

  if (!GOOGLE_CLIENT_SECRET || !DRIVE_SERVER_REFRESH_TOKEN || !ALLOWED_EMAILS.length) {
    res.status(500).json({
      error: 'server_misconfigured',
      error_description: 'GOOGLE_CLIENT_SECRET, DRIVE_SERVER_REFRESH_TOKEN, and ALLOWED_EMAILS must all be set in Vercel env vars'
    });
    return;
  }

  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.replace(/^Bearer\s+/i, '') || (req.body && req.body.idToken) || req.query.idToken;
  if (!idToken) { res.status(401).json({ error: 'missing_id_token' }); return; }

  let email;
  try {
    email = await verifyIdToken(idToken);
  } catch (err) {
    res.status(403).json({ error: 'forbidden', error_description: String(err && err.message ? err.message : err) });
    return;
  }

  try {
    const driveToken = await getServerDriveAccessToken();

    if (req.method === 'GET') {
      const file = await findBackupFile(driveToken);
      if (!file) { res.status(404).json({ error: 'no_backup_found' }); return; }
      const r = await fetch('https://www.googleapis.com/drive/v3/files/' + file.id + '?alt=media', {
        headers: { Authorization: 'Bearer ' + driveToken }
      });
      const text = await r.text();
      if (!r.ok) { res.status(r.status).json({ error: 'drive_download_failed', error_description: text.slice(0, 300) }); return; }
      res.setHeader('Content-Type', 'application/json');
      res.status(200).send(text);
      return;
    }

    if (req.method === 'POST') {
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        res.status(400).json({ error: 'invalid_body', error_description: 'Expected a JSON object with clients/trips/vendors/planner' });
        return;
      }
      const content = JSON.stringify(body);
      const existing = await findBackupFile(driveToken);

      if (existing) {
        const r = await fetch('https://www.googleapis.com/upload/drive/v3/files/' + existing.id + '?uploadType=media&fields=id,modifiedTime', {
          method: 'PATCH',
          headers: { Authorization: 'Bearer ' + driveToken, 'Content-Type': 'application/json' },
          body: content
        });
        const data = await r.json();
        if (!r.ok) { res.status(r.status).json(data); return; }
        res.status(200).json({ ok: true, fileId: data.id, modifiedTime: data.modifiedTime, syncedBy: email });
        return;
      }

      const boundary = 'secure_sync_' + Date.now();
      const metadata = JSON.stringify({ name: BACKUP_FILENAME, mimeType: 'application/json' });
      const multipartBody =
        '--' + boundary + '\r\n' +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' + metadata + '\r\n' +
        '--' + boundary + '\r\n' +
        'Content-Type: application/json\r\n\r\n' + content + '\r\n' +
        '--' + boundary + '--';
      const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + driveToken, 'Content-Type': 'multipart/related; boundary=' + boundary },
        body: multipartBody
      });
      const data = await r.json();
      if (!r.ok) { res.status(r.status).json(data); return; }
      res.status(200).json({ ok: true, fileId: data.id, modifiedTime: data.modifiedTime, syncedBy: email });
      return;
    }

    res.status(405).json({ error: 'method_not_allowed' });
  } catch (err) {
    res.status(500).json({ error: 'server_error', error_description: String(err && err.message ? err.message : err) });
  }
};
