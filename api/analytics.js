import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});
const INTERNAL_TOKEN = 'studyos-analytics-2026-cd';

async function loadEvents(ip) {
  const raw = await redis.lrange(`guest:events:${ip}`, 0, 99);
  return raw.map(e => {
    try { return typeof e === 'string' ? JSON.parse(e) : e; }
    catch { return null; }
  }).filter(Boolean);
}

export default async function handler(req, res) {
  if (req.query.token !== INTERNAL_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Merge deux IPs sous une même identité
  if (req.query.action === 'merge') {
    const { primary, secondary } = req.query;
    if (!primary || !secondary) return res.status(400).json({ error: 'primary + secondary requis' });

    const [pData, sData] = await Promise.all([
      redis.get(`guest:${primary}`),
      redis.get(`guest:${secondary}`),
    ]);
    if (!pData || !sData) return res.status(404).json({ error: 'IP introuvable' });

    // Fusionner les events du secondaire dans le primaire
    const secEvents = await loadEvents(secondary);
    if (secEvents.length) {
      await redis.lpush(`guest:events:${primary}`, ...secEvents.map(e => JSON.stringify(e)));
      await redis.ltrim(`guest:events:${primary}`, 0, 99);
    }

    // Mettre à jour l'entrée primaire
    const mergedData = {
      ...pData,
      firstSeen: Math.min(pData.firstSeen || Infinity, sData.firstSeen || Infinity),
      lastSeen: Math.max(pData.lastSeen || 0, sData.lastSeen || 0),
      count: (pData.count || 0) + (sData.count || 0),
      merged_ips: [...(pData.merged_ips || []), secondary],
    };
    await redis.set(`guest:${primary}`, mergedData);

    // Marquer le secondaire comme fusionné (garder la trace)
    await redis.set(`guest:${secondary}`, { merged_into: primary, name: sData.name });

    return res.json({ ok: true, primary, secondary, totalCount: mergedData.count });
  }

  const members = await redis.zrange('guests:connections', 0, -1, { rev: true });
  const guests = await Promise.all(
    members.slice(0, 200).map(ip => redis.get(`guest:${ip}`).then(d => ({ ip, ...d })))
  );

  // Filtrer les entrées fusionnées (merged_into = pointeurs vers une autre IP)
  const active = guests
    .filter(g => g && !g.merged_into)
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));

  if (req.query.action === 'cleanup') {
    const toDelete = active.filter(g => !g.name || g.name === 'invité');
    await Promise.all(toDelete.map(g => {
      redis.del(`guest:${g.ip}`);
      redis.zrem('guests:connections', g.ip);
    }));
    return res.json({ deleted: toDelete.length, remaining: active.length - toDelete.length });
  }

  if (req.query.events === '1') {
    const withEvents = await Promise.all(
      active.map(async g => {
        // Charger les events de l'IP primaire + toutes les IPs fusionnées
        const allIPs = [g.ip, ...(g.merged_ips || [])];
        const allEventsArrays = await Promise.all(allIPs.map(loadEvents));
        const events = allEventsArrays.flat().sort((a, b) => (b.t || 0) - (a.t || 0)).slice(0, 20);

        const sessionEnd = events.find(e => e.type === 'session_end');
        const scores = events.filter(e => e.pct != null).map(e => ({ type: e.type, subject: e.subject, pct: e.pct }));

        return {
          ip: g.ip,
          name: g.name,
          count: g.count,
          merged_ips: g.merged_ips || [],
          firstSeen: g.firstSeen ? new Date(g.firstSeen).toISOString() : null,
          lastSeen: g.lastSeen ? new Date(g.lastSeen).toISOString() : null,
          sessionDuration: sessionEnd?.duration || null,
          scores,
          recentEvents: events.slice(0, 15),
        };
      })
    );
    return res.json({ total: withEvents.length, guests: withEvents });
  }

  res.json({
    total: active.length,
    guests: active.map(g => ({
      ip: g.ip,
      name: g.name,
      count: g.count,
      merged_ips: g.merged_ips || [],
      firstSeen: g.firstSeen ? new Date(g.firstSeen).toISOString() : null,
      lastSeen: g.lastSeen ? new Date(g.lastSeen).toISOString() : null,
    })),
  });
}
