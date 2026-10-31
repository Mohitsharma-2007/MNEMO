import type { VercelRequest, VercelResponse } from '@vercel/node';

let applicationModule: Promise<typeof import('../server/src/index.js')> | null = null;

function loadApplication() {
  if (!applicationModule) applicationModule = import('../server/src/index.js');
  return applicationModule;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS configuration for Vercel Serverless deployment
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Client-Info, apikey, X-Processor-Key');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const { default: app, ensureDatabase } = await loadApplication();
    await ensureDatabase();
    return (app as any)(req, res);
  } catch (error) {
    console.error('[AttendX] Serverless database initialization failed', error);
    return res.status(503).json({
      error: 'The AttendX database is temporarily unavailable. Configure MONGODB_URI or DATABASE_URL for production persistence.',
    });
  }
}
