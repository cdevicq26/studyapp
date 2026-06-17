import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

function getIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  return (forwarded ? forwarded.split(',')[0] : req.socket?.remoteAddress || 'unknown').trim();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ip = getIP(req);
  const key = `guest:${ip}`;

  if (req.method === 'GET') {
    const data = await redis.get(key);
    return res.json({ name: data?.name || null });
  }

  if (req.method === 'POST') {
    const body = req.body || {};

    // Action : event analytique
    if (body.action === 'event') {
      const eventsKey = `guest:events:${ip}`;
      const event = { t: body.t || Date.now(), type: body.type, ...Object.fromEntries(
        Object.entries(body).filter(([k]) => !['action', 't'].includes(k))
      )};
      await redis.lpush(eventsKey, JSON.stringify(event));
      await redis.ltrim(eventsKey, 0, 99);
      return res.json({ ok: true });
    }

    // Action : enregistrement invité (avec device info)
    const { name, device, browser, language, timezone, screen, theme, connection } = body;
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name required' });
    const clean = name.trim().slice(0, 30);
    const now = Date.now();
    const existing = await redis.get(key) || { firstSeen: now, count: 0 };
    const updated = {
      name: clean,
      firstSeen: existing.firstSeen,
      lastSeen: now,
      count: (existing.count || 0) + 1,
      device: device || existing.device,
      browser: browser || existing.browser,
      language: language || existing.language,
      timezone: timezone || existing.timezone,
      screen: screen || existing.screen,
      theme: theme || existing.theme,
      connection: connection || existing.connection,
    };
    await redis.set(key, updated);
    await redis.zadd('guests:connections', { score: now, member: ip });
    return res.json({ ok: true, name: clean });
  }

  res.status(405).json({ error: 'method not allowed' });
}
