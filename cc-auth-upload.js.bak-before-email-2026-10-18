// Miles Man CRM — public Credit Card Authorization Form upload.
//
// WHERE THIS GOES: copy to api/cc-auth-upload.js in the milesman-auth Vercel
// project (C:\Users\ericl\milesman-auth-fix), then `vercel --prod`. Not part
// of the milesman-crm repo's own deploy (GitHub Pages, static files only,
// no secret storage) — the public page that POSTs here is cc-auth-upload.html
// in this repo.
//
// WHAT THIS DOES: a client opens a personalized link (generated from their
// CRM record — index.html's "Copy Upload Link" button on the client form,
// §4.12 in DOCUMENTATION.md) and uploads their completed, signed credit card
// authorization PDF. There's no login for the client — this endpoint is
// public the same way the Book a Trip form and the Jetpack subscribe
// endpoint are, and treats every request as untrusted input to validate,
// not as an authenticated call. The PDF is uploaded server-side straight
// into a private Google Drive folder using the SAME server-held Drive
// credential api/secure-sync.js already established — the browser (client
// or CRM) never holds a credential capable of reading Drive, only of
// POSTing a new file to this one endpoint.
//
// REQUIRED VERCEL ENV VARS (both already set for api/secure-sync.js):
//   GOOGLE_CLIENT_SECRET      — same OAuth 2.0 Client Secret Drive
//                               Backup/Restore and Secure Sync use
//   DRIVE_SERVER_REFRESH_TOKEN — a real refresh token for the account that
//                               should own the uploaded files (Debug Panel's
//                               "Copy Drive Refresh Token" button in the CRM,
//                               same value Secure Sync setup already used)
// No new env vars needed if Secure Sync (§4.1a) is already configured.
//
// WHETHER UPLOADS SHOW UP IN THE CRM'S OWN "Browse Google Drive" PICKER IS
// GENUINELY UNCERTAIN — treat this with real caution, not optimism. A live
// test against a real account already confirmed drive.file scope is
// stricter than hoped: this server-side credential could NOT see a "Miles
// Man" folder the account owner created by hand in the Drive website (see
// getUploadFolderId()'s comment below) — only folders it created itself
// were visible to it. Whether the CRM's own separate browser-side
// drive.file token (same OAuth Client ID, same account, but a DIFFERENT
// authorization grant) can see folders THIS credential created is a
// different question that hasn't been tested either way. If a client's
// uploaded PDF doesn't turn up in the CRM's Drive picker, that's not
// necessarily a failed upload — check the Google Drive web UI directly
// (drive.google.com, under whichever account owns DRIVE_SERVER_REFRESH_TOKEN,
// search "Credit Card Authorization Forms") before assuming anything went
// wrong; the file is very likely there regardless of what the picker shows.
//
// FILE SIZE: capped at 8MB (MAX_BYTES below), matching cc-auth-upload.html's
// own client-side cap — keep the two in sync if this is ever changed.
// This is deliberately conservative, NOT a confirmed Vercel platform limit:
// standard Node.js Serverless Functions have historically capped request
// bodies well under 8MB on some plans, so if uploads fail with a 413 here,
// lower MAX_BYTES in both files, or move this endpoint to an Edge Function
// (different body-size rules) — verify against whatever the account's
// actual Vercel plan documents before raising it.
//
// SECURITY NOTE: this endpoint is intentionally public and unauthenticated,
// same trust model as the Book a Trip form (§4.4) — anyone with a link can
// upload a PDF, but the link grants no read access to anything, and every
// upload is validated server-side (real PDF magic bytes, not just the
// client-side .pdf check, which a malicious caller could bypass entirely)
// before it's written to Drive. There is no rate limiting — a determined
// abuser could still spam small PDFs at this endpoint; that's an accepted
// gap for a low-traffic single-client-facing form, not something this file
// defends against.

const DRIVE_CLIENT_ID = '1055867383042-an9l58o1qg22pt7o4ak8vaneeftv54ib.apps.googleusercontent.com';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const PARENT_FOLDER_NAME = 'Miles Man';
const FOLDER_NAME = 'Credit Card Authorization Forms';
const MAX_BYTES = 8 * 1024 * 1024;
const PDF_MAGIC = Buffer.from('%PDF');

async function getServerDriveAccessToken() {
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.DRIVE_SERVER_REFRESH_TOKEN;
  if (!clientSecret || !refreshToken) {
    throw new Error('server_not_configured: GOOGLE_CLIENT_SECRET / DRIVE_SERVER_REFRESH_TOKEN are not set on this Vercel project.');
  }
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: DRIVE_CLIENT_ID,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    }).toString()
  });
  const data = await r.json();
  if (!r.ok || !data.access_token) {
    throw new Error('drive_auth_failed: ' + (data.error_description || data.error || 'could not refresh the server Drive credential'));
  }
  return data.access_token;
}

// Finds a folder by name under a given parent, creating it the first time
// this runs. Safe to call on every request — Drive API list/create calls
// are cheap, and there's no local state a serverless function could cache
// this in between cold starts anyway. parentId is always required and
// explicit (rather than letting Drive default an unspecified parent to
// root) so a same-named folder living somewhere else in the account can
// never be matched by accident.
async function getOrCreateFolder(accessToken, name, parentId) {
  const q = "mimeType='application/vnd.google-apps.folder' and name='" + name + "' and trashed=false and '" + parentId + "' in parents";
  const listUrl = DRIVE_FILES_URL + '?q=' + encodeURIComponent(q) + '&fields=' + encodeURIComponent('files(id,name)');
  const listRes = await fetch(listUrl, { headers: { Authorization: 'Bearer ' + accessToken } });
  const listData = await listRes.json();
  if (listRes.ok && listData.files && listData.files.length) {
    return listData.files[0].id;
  }
  const createRes = await fetch(DRIVE_FILES_URL + '?fields=id', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] })
  });
  const createData = await createRes.json();
  if (!createRes.ok || !createData.id) {
    throw new Error('drive_folder_failed: ' + (createData.error && createData.error.message || 'could not create the "' + name + '" folder'));
  }
  return createData.id;
}

// Finds a folder by name ANYWHERE this credential has access to, with no
// parent constraint at all. Used only for the one-time "does the upload
// folder already exist" check below — deliberately looser than
// getOrCreateFolder()'s parent-scoped lookup, because drive.file scope
// (§4.1) only grants an app visibility into files/folders it created (or
// that were explicitly opened with it via a Picker) REGARDLESS of where
// they currently live in the account. This is what makes a one-time manual
// re-parenting in the Drive UI (see below) stick permanently, instead of
// this code re-creating a fresh duplicate on every future request.
async function findFolderAnywhere(accessToken, name) {
  const q = "mimeType='application/vnd.google-apps.folder' and name='" + name + "' and trashed=false";
  const listUrl = DRIVE_FILES_URL + '?q=' + encodeURIComponent(q) + '&fields=' + encodeURIComponent('files(id,name)');
  const listRes = await fetch(listUrl, { headers: { Authorization: 'Bearer ' + accessToken } });
  const listData = await listRes.json();
  if (listRes.ok && listData.files && listData.files.length) {
    return listData.files[0].id;
  }
  return null;
}

// Resolves the Credit Card Authorization Forms upload folder.
//
// CONFIRMED (not just suspected) against a real account: drive.file scope
// means this server credential cannot see a "Miles Man" folder the account
// owner created by hand in the Drive website — only folders THIS credential
// itself created are visible to it, no matter the folder name or location.
// A naive "find Miles Man under root, then find/create Credit Card
// Authorization Forms under that" (the original approach) therefore never
// finds the real, hand-created Miles Man folder and creates a brand new,
// separate one on every cold start — Drive allows duplicate folder names,
// so this silently produces a fresh "Miles Man" duplicate (shown in Drive's
// own UI with a "(1)"/"(2)" disambiguation suffix) instead of erroring.
//
// The fix: check for an existing "Credit Card Authorization Forms" folder
// by name FIRST, with no parent constraint (findFolderAnywhere above) —
// this finds it wherever it currently lives, including after being moved.
// Combined with a ONE-TIME manual step (move the folder this credential
// created into the account's real "Miles Man" folder, then delete the
// leftover empty duplicate), every future request finds that exact same
// folder by its Drive file ID and reuses it — moving a file never changes
// its ID or this credential's access to it, only which folder currently
// contains it. Only on a true first run (no Credit Card Authorization
// Forms folder exists anywhere this credential can see) does this fall
// back to creating a fresh Miles Man + Credit Card Authorization Forms
// pair from scratch.
async function getUploadFolderId(accessToken) {
  const existing = await findFolderAnywhere(accessToken, FOLDER_NAME);
  if (existing) return existing;

  const milesManId = await getOrCreateFolder(accessToken, PARENT_FOLDER_NAME, 'root');
  return getOrCreateFolder(accessToken, FOLDER_NAME, milesManId);
}

// Keeps the filename readable and safe for Drive/downstream tools without
// leaking arbitrary client input straight into the name — strips anything
// that isn't a common filename character.
function sanitizeForFilename(str) {
  return (str || '').toString().trim().replace(/[^\w \-().]/g, '').slice(0, 80);
}

module.exports = async (req, res) => {
  // Same origin every other proxy endpoint in this app allows — the public
  // upload page is served from GitHub Pages alongside the CRM itself.
  res.setHeader('Access-Control-Allow-Origin', 'https://milesmaneric.github.io');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const body = req.body || {};
  const clientId = (body.clientId || '').toString().trim();
  const clientName = (body.clientName || '').toString().trim();
  // Only ever populated from the generic (no cid) link, where the visitor
  // typed their own name/email in directly since there's no CRM record to
  // pull them from yet — see cc-auth-upload.html's identify-fields.
  const clientEmail = (body.clientEmail || '').toString().trim();
  const filename = (body.filename || '').toString().trim();
  const fileBase64 = body.fileBase64;

  if (!fileBase64) {
    res.status(400).json({ error: 'missing_file', error_description: 'No file data was received.' });
    return;
  }

  let buffer;
  try {
    buffer = Buffer.from(fileBase64, 'base64');
  } catch (e) {
    res.status(400).json({ error: 'bad_file_data', error_description: 'The uploaded file could not be decoded.' });
    return;
  }

  if (!buffer.length) {
    res.status(400).json({ error: 'empty_file', error_description: 'The uploaded file is empty.' });
    return;
  }
  if (buffer.length > MAX_BYTES) {
    res.status(413).json({ error: 'file_too_large', error_description: 'The file is larger than the ' + Math.round(MAX_BYTES / 1024 / 1024) + 'MB limit.' });
    return;
  }
  // Real server-side validation — the client-side .pdf/mime-type check in
  // cc-auth-upload.html is only a UX convenience and trivial to bypass, so
  // this is the actual security boundary against something other than a
  // PDF landing in the authorization-forms folder.
  if (buffer.subarray(0, 4).compare(PDF_MAGIC) !== 0) {
    res.status(400).json({ error: 'not_a_pdf', error_description: 'That file is not a valid PDF.' });
    return;
  }

  try {
    const accessToken = await getServerDriveAccessToken();
    const folderId = await getUploadFolderId(accessToken);

    const namePart = sanitizeForFilename(clientName) || 'Unknown Client';
    // Prefer the real CRM client id (personalized link); fall back to
    // whatever email the visitor typed in on the generic link, since
    // that's a far more useful matching key for staff than "no-id".
    const idPart = sanitizeForFilename(clientId) || sanitizeForFilename(clientEmail) || 'no-id';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const driveFilename = 'CC Auth - ' + namePart + ' (' + idPart + ') - ' + stamp + '.pdf';

    const metadata = { name: driveFilename, parents: [folderId] };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', new Blob([buffer], { type: 'application/pdf' }), driveFilename);

    const uploadRes = await fetch(DRIVE_UPLOAD_URL + '?uploadType=multipart&fields=id,name,webViewLink', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + accessToken },
      body: form
    });
    const uploadData = await uploadRes.json();
    if (!uploadRes.ok || !uploadData.id) {
      throw new Error('drive_upload_failed: ' + (uploadData.error && uploadData.error.message || 'Drive rejected the upload'));
    }

    res.status(200).json({ ok: true, fileId: uploadData.id, fileName: uploadData.name, webViewLink: uploadData.webViewLink });
  } catch (e) {
    res.status(500).json({ error: 'upload_error', error_description: e.message });
  }
};
