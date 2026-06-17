import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});
const INTERNAL_TOKEN = 'studyos-analytics-2026-cd';

export default async function handler(req, res) {
  if (req.query.token !== INTERNAL_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const members = await redis.zrange('guests:connections', 0, -1, { rev: true });
  const guests = await Promise.all(
    members.slice(0, 200).map(ip => redis.get(`guest:${ip}`).then(d => ({ ip, ...d })))
  );

  const sorted = guests
    .filter(Boolean)
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));

  if (req.query.action === 'cleanup') {
    const toDelete = sorted.filter(g => !g.name || g.name === 'invité');
    await Promise.all(toDelete.map(g => {
      redis.del(`guest:${g.ip}`);
      redis.zrem('guests:connections', g.ip);
    }));
    return res.json({ deleted: toDelete.length, remaining: sorted.length - toDelete.length });
  }

  // Avec events : charger les 20 derniers events par invité
  if (req.query.events === '1') {
    const withEvents = await Promise.all(
      sorted.map(async g => {
        const raw = await redis.lrange(`guest:events:${g.ip}`, 0, 19);
        const events = raw.map(e => {
          try { return typeof e === 'string' ? JSON.parse(e) : e; }
          catch { return null; }
        }).filter(Boolean);

        // Agréger : sujets visités, exercices joués, scores moyens
        const subjects = [...new Set(events.filter(e => e.subject).map(e => e.subject))];
        const sessionEnd = events.find(e => e.type === 'session_end');
        const scores = events
          .filter(e => e.pct != null)
          .map(e => ({ type: e.type, subject: e.subject, pct: e.pct }));

        return {
          name: g.name,
          device: g.device,
          browser: g.browser,
          language: g.language,
          timezone: g.timezone,
          screen: g.screen,
          theme: g.theme,
          count: g.count,
          firstSeen: g.firstSeen ? new Date(g.firstSeen).toISOString() : null,
          lastSeen: g.lastSeen ? new Date(g.lastSeen).toISOString() : null,
          sessionDuration: sessionEnd?.duration || null,
          subjectsVisited: subjects,
          scores,
          recentEvents: events.slice(0, 10),
        };
      })
    );
    return res.json({ total: withEvents.length, guests: withEvents });
  }

  res.json({
    total: sorted.length,
    guests: sorted.map(g => ({
      name: g.name,
      device: g.device,
      browser: g.browser,
      language: g.language,
      timezone: g.timezone,
      screen: g.screen,
      theme: g.theme,
      count: g.count,
      firstSeen: g.firstSeen ? new Date(g.firstSeen).toISOString() : null,
      lastSeen: g.lastSeen ? new Date(g.lastSeen).toISOString() : null,
    })),
  });
}
