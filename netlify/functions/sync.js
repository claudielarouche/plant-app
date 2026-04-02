// netlify/functions/sync.js
const { getStore } = require('@netlify/blobs');

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

function isValidId(id) {
  return typeof id === 'string' && /^[a-z0-9\-]{8,64}$/.test(id);
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async (event) => {
  const jsonHeaders = { 'Content-Type': 'application/json', ...corsHeaders };
  const qs = event.queryStringParameters || {};

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: jsonHeaders, body: '' };
  }

  const siteID = process.env.SITE_ID;
  const token = process.env.NETLIFY_TOKEN;

  if (!siteID || !token) {
    return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({
      error: 'Missing configuration',
      detail: `SITE_ID=${siteID ? 'set' : 'MISSING'}, NETLIFY_TOKEN=${token ? 'set' : 'MISSING — add this in Site configuration → Environment variables'}`
    })};
  }

  let store;
  try {
    store = getStore({ name: 'garden-journal', siteID, token });
  } catch (err) {
    return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: 'Could not initialise store', detail: err.message }) };
  }

  // ── Photo operations (?op=photo&id={photoId}) ─────────────────
  if (qs.op === 'photo') {
    const photoId = qs.id;
    if (!photoId || !isValidId(photoId)) {
      return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: 'Invalid photo ID' }) };
    }
    const photoKey = `photo-${photoId}`;

    // GET — serve the photo as a real image response
    if (event.httpMethod === 'GET') {
      try {
        const result = await store.getWithMetadata(photoKey, { type: 'arrayBuffer' });
        if (!result || !result.data) {
          return { statusCode: 404, headers: jsonHeaders, body: JSON.stringify({ error: 'Photo not found' }) };
        }
        const { data, metadata } = result;
        return {
          statusCode: 200,
          headers: {
            'Content-Type': metadata.mimeType || 'image/jpeg',
            'Cache-Control': 'public, max-age=31536000, immutable',
            ...corsHeaders
          },
          body: Buffer.from(data).toString('base64'),
          isBase64Encoded: true
        };
      } catch (err) {
        return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: 'Failed to read photo', detail: err.message }) };
      }
    }

    // POST — upload a photo (body: { dataUrl: 'data:image/jpeg;base64,...' })
    if (event.httpMethod === 'POST') {
      try {
        const raw = event.isBase64Encoded
          ? Buffer.from(event.body, 'base64').toString('utf8')
          : (event.body || '{}');

        if (raw.length > MAX_BODY_BYTES) {
          return { statusCode: 413, headers: jsonHeaders, body: JSON.stringify({ error: 'Photo too large (max 10 MB)' }) };
        }

        const { dataUrl } = JSON.parse(raw);
        if (!dataUrl || !dataUrl.startsWith('data:')) {
          return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: 'Invalid photo data' }) };
        }

        const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
        if (!match) {
          return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: 'Invalid data URL format' }) };
        }

        const [, mimeType, base64] = match;
        const buffer = Buffer.from(base64, 'base64');
        await store.set(photoKey, buffer, { metadata: { mimeType } });

        return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ ok: true, photoId }) };
      } catch (err) {
        return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: 'Failed to save photo', detail: err.message }) };
      }
    }

    // DELETE — remove a photo
    if (event.httpMethod === 'DELETE') {
      try {
        await store.delete(photoKey);
        return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ ok: true }) };
      } catch (err) {
        return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: 'Failed to delete photo', detail: err.message }) };
      }
    }

    return { statusCode: 405, headers: jsonHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // ── Garden data operations (?id={gardenId}) ───────────────────
  const gardenId = qs.id;
  if (!gardenId || !isValidId(gardenId)) {
    return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: 'Invalid or missing garden ID' }) };
  }

  if (event.httpMethod === 'GET') {
    try {
      // ?op=backup — return the saved backup snapshot
      if (qs.op === 'backup') {
        const backup = await store.get(`${gardenId}-backup`, { type: 'json' });
        return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify(backup || null) };
      }
      const data = await store.get(gardenId, { type: 'json' });
      return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify(data || { plants: [], logs: [], settings: {} }) };
    } catch (err) {
      return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: 'Failed to read data', detail: err.message }) };
    }
  }

  if (event.httpMethod === 'POST') {
    try {
      const body = event.isBase64Encoded
        ? Buffer.from(event.body, 'base64').toString('utf8')
        : (event.body || '{}');

      if (body.length > MAX_BODY_BYTES) {
        return { statusCode: 413, headers: jsonHeaders, body: JSON.stringify({ error: 'Payload too large' }) };
      }

      const data = JSON.parse(body);
      if (!Array.isArray(data.plants) || !Array.isArray(data.logs)) {
        return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: 'Invalid data format' }) };
      }

      // Save current server state as backup before overwriting
      try {
        const existing = await store.get(gardenId, { type: 'json' });
        if (existing && existing.plants?.length) {
          await store.setJSON(`${gardenId}-backup`, { ...existing, backedUpAt: new Date().toISOString() });
        }
      } catch (_) { /* backup failure is non-fatal */ }

      const sanitized = { ...data, syncedAt: new Date().toISOString() };
      await store.setJSON(gardenId, sanitized);
      return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ ok: true, syncedAt: sanitized.syncedAt }) };
    } catch (err) {
      return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: 'Failed to save data', detail: err.message }) };
    }
  }

  return { statusCode: 405, headers: jsonHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };
};
