import { Redis } from '@upstash/redis';

const JOB_TTL_SECONDS = 300; // 5 min — au-delà, le job est considéré abandonné

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

function makeJobId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export default async function handler(req, res) {
  if (req.method === 'POST') {
    const { message, history } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message requis' });
    }

    const jobId = makeJobId();
    const job = {
      status: 'pending',
      message,
      history: Array.isArray(history) ? history : [],
      createdAt: Date.now(),
    };

    await redis.set(`chat:job:${jobId}`, JSON.stringify(job), { ex: JOB_TTL_SECONDS });
    await redis.lpush('chat:queue', jobId);

    return res.status(200).json({ jobId });
  }

  if (req.method === 'GET') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id requis' });

    const raw = await redis.get(`chat:job:${id}`);
    if (!raw) return res.status(404).json({ error: 'job introuvable ou expiré — le script sur ton Mac tourne-t-il ?' });

    const job = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return res.status(200).json({
      status: job.status,
      reply: job.reply || null,
      sources: job.sources || [],
      error: job.error || null,
    });
  }

  return res.status(405).json({ error: 'method not allowed' });
}
