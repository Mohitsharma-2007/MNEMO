import path from 'node:path';

/** Writable runtime paths for local Node and Vercel serverless execution. */
export const uploadsDirectory = process.env.VERCEL
  ? path.join('/tmp', 'attendx', 'uploads')
  : path.resolve(process.cwd(), 'uploads');
