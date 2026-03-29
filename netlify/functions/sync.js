// netlify/functions/sync.js
// @netlify/blobs is pre-installed in Netlify's Functions runtime — no npm install needed.

const { getStore } = require('@netlify/blobs');

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

function isValidId(id) {
  return typeof id === 'string' && /^[a-z0-9\-]{8,64}$/.test(id);
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', ...corsHeaders };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const gardenId = event.queryStringParameters && event.queryStringParameters.id;

  if (!gardenId || !isValidId(gardenId)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid or missing garden ID' }) };
  }

  let store;
  try {
    store = getStore('garden-journal');
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not initialise store', detail: err.message }) };
  }

  if (event.httpMethod === 'GET') {
    try {
      const data = await store.get(gardenId, { type: 'json' });
      return { statusCode: 200, headers, body: JSON.stringify(data || { plants: [], logs: [], settings: {} }) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to read data', detail: err.message }) };
    }
  }

  if (event.httpMethod === 'POST') {
    try {
      const body = event.isBase64Encoded
        ? Buffer.from(event.body, 'base64').toString('utf8')
        : (event.body || '{}');

      if (body.length > MAX_BODY_BYTES) {
        return { statusCode: 413, headers, body: JSON.stringify({ error: 'Payload too large' }) };
      }

      const data = JSON.parse(body);
      if (!Array.isArray(data.plants) || !Array.isArray(data.logs)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid data format' }) };
      }

      const sanitized = { ...data, syncedAt: new Date().toISOString() };
      await store.setJSON(gardenId, sanitized);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, syncedAt: sanitized.syncedAt }) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to save data', detail: err.message }) };
    }
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};
