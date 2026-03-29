// Netlify Functions v2 — @netlify/blobs is built-in, no npm install needed
import { getStore } from '@netlify/blobs';

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

function isValidId(id) {
  return typeof id === 'string' && /^[a-z0-9\-]{8,64}$/.test(id);
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default async (req) => {
  const json = (status, data) => new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const url = new URL(req.url);
  const gardenId = url.searchParams.get('id');

  if (!gardenId || !isValidId(gardenId)) {
    return json(400, { error: 'Invalid or missing garden ID (8–64 chars, lowercase letters/numbers/hyphens)' });
  }

  const store = getStore('garden-journal');

  if (req.method === 'GET') {
    try {
      const data = await store.get(gardenId, { type: 'json' });
      return json(200, data || { plants: [], logs: [], settings: {} });
    } catch (err) {
      console.error('GET error:', err);
      return json(500, { error: 'Failed to read data', detail: err.message });
    }
  }

  if (req.method === 'POST') {
    try {
      const text = await req.text();
      if (text.length > MAX_BODY_BYTES) {
        return json(413, { error: 'Payload too large (max 10 MB)' });
      }

      const data = JSON.parse(text);
      if (!Array.isArray(data.plants) || !Array.isArray(data.logs)) {
        return json(400, { error: 'Invalid data format' });
      }

      const sanitized = { ...data, syncedAt: new Date().toISOString() };
      await store.setJSON(gardenId, sanitized);
      return json(200, { ok: true, syncedAt: sanitized.syncedAt });
    } catch (err) {
      console.error('POST error:', err);
      return json(500, { error: 'Failed to save data', detail: err.message });
    }
  }

  return json(405, { error: 'Method not allowed' });
};

export const config = { path: '/api/sync' };
