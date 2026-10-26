// api/claude-messages.js
// Vercel serverless function: proxies requests to Anthropic's Messages API so
// the browser (milesman-crm's in-app Assistant chat widget) never needs the
// Anthropic API key directly. The browser sends the conversation (messages),
// tool definitions, and system prompt; this just attaches the server-held
// key and relays the request/response verbatim. It never touches the CRM's
// own data — all tool execution happens client-side in index.html.
//
// IMPORTANT: set ANTHROPIC_API_KEY in Vercel's Environment Variables
// (Settings -> Environment Variables).

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 1536;

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

  if (!ANTHROPIC_API_KEY) {
    res.status(500).json({ error: 'server_misconfigured', error_description: 'ANTHROPIC_API_KEY environment variable is not set' });
    return;
  }

  try {
    const body = req.body || {};
    const messages = body.messages;
    if (!Array.isArray(messages) || !messages.length) {
      res.status(400).json({ error: 'invalid_request', error_description: 'Provide a non-empty "messages" array' });
      return;
    }

    const payload = {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: messages
    };
    if (body.system) payload.system = body.system;
    if (Array.isArray(body.tools) && body.tools.length) payload.tools = body.tools;

    const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(payload)
    });

    const data = await anthropicResponse.json();
    res.status(anthropicResponse.status).json(data);
  } catch (err) {
    res.status(500).json({ error: 'server_error', error_description: String(err && err.message ? err.message : err) });
  }
};
