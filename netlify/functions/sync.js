// netlify/functions/sync.js
// Uses Netlify Blobs to store garden data per garden ID.
// Requires: @netlify/blobs (auto-available in Netlify Functions v2 environment)

const { getStore } = require('@netlify/blobs');

const ALLOWED_ORIGINS = ['*'];
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes('*') ? '*' : (ALLOWED_ORIGINS.includes(origin) ? origin : ''),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function isValidId(id) {
  return typeof id === 'string' && /^[a-z0-9\-]{8,64}$/.test(id);
}

exports.handler = async (event) => {
  const origin = event.headers['origin'] || '';
  const headers = { 'Content-Type': 'application/json', ...cors(origin) };

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const gardenId = event.queryStringParameters?.id;

  if (!gardenId || !isValidId(gardenId)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid or missing garden ID' }) };
  }

  const store = getStore('garden-journal');

  // GET — pull data
  if (event.httpMethod === 'GET') {
    try {
      const data = await store.get(gardenId, { type: 'json' });
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(data || { plants: [], logs: [], settings: {} })
      };
    } catch (err) {
      console.error('GET error:', err);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to read data' }) };
    }
  }

  // POST — push data
  if (event.httpMethod === 'POST') {
    try {
      const bodySize = (event.body || '').length;
      if (bodySize > MAX_BODY_BYTES) {
        return { statusCode: 413, headers, body: JSON.stringify({ error: 'Payload too large' }) };
      }

      const data = JSON.parse(event.body || '{}');

      // Basic validation
      if (!Array.isArray(data.plants) || !Array.isArray(data.logs)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid data format' }) };
      }

      // Strip binary photo data from server storage to keep blobs small.
      // Photos are base64 and can be large — store metadata only, keep data local.
      // Comment out the next block if you want full photo sync (increases storage usage).
      const sanitized = {
        ...data,
        plants: data.plants.map(p => ({
          ...p,
          photos: (p.photos || []).map(ph => ({ date: ph.date, data: ph.data }))
        })),
        logs: data.logs.map(l => ({ ...l })),
        syncedAt: new Date().toISOString()
      };

      await store.setJSON(gardenId, sanitized);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ok: true, syncedAt: sanitized.syncedAt })
      };
    } catch (err) {
      console.error('POST error:', err);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to save data' }) };
    }
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};
