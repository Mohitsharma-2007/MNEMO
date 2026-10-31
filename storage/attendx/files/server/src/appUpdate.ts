import type { Request, Response } from 'express';

/**
 * App update service.
 *
 * The Android APK is published as a GitHub Releases asset. The client asks
 * this endpoint for the latest version; when a newer versionCode is available
 * the app shows an update notice and the admin mass-mail includes the link.
 *
 * Resolution order:
 *  1. ATX_LATEST_APK_URL / ATX_LATEST_VERSION / ATX_LATEST_VERSION_CODE env
 *     overrides (explicit pinning without a GitHub round-trip).
 *  2. GitHub Releases "latest" for ATX_GITHUB_REPO (default repo below),
 *     picking the first .apk asset.
 *
 * The GitHub lookup is cached in memory for 10 minutes.
 */

const GITHUB_REPO = process.env.ATX_GITHUB_REPO || 'Mohitsharma-2007/AttendX';
const FALLBACK_URL = `https://github.com/${GITHUB_REPO}/releases/latest`;
const CACHE_TTL_MS = 10 * 60 * 1000;

interface LatestRelease {
  version: string;
  versionCode: number;
  apkUrl: string;
  releasePage: string;
  releaseNotes: string;
  publishedAt: string | null;
}

let cache: { at: number; data: LatestRelease } | null = null;

function pickApkAsset(assets: any[]): any | null {
  const list = assets || [];
  // Prefer the signed release build over the debug APK when both are published.
  return (
    list.find((a) => /\.apk$/i.test(a.name || '') && !/debug/i.test(a.name || '')) ||
    list.find((a) => /\.apk$/i.test(a.name || '')) ||
    null
  );
}

async function fetchFromGitHub(): Promise<LatestRelease | null> {
  try {
    const headers: Record<string, string> = { 'User-Agent': 'AttendX-Update-Service' };
    if (process.env.GITHUB_TOKEN) headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const apk = pickApkAsset(data.assets || []);
    const tag: string = data.tag_name || data.name || '';
    const version = (apk?.name?.match(/v?(\d+\.\d+\.\d+)/)?.[1]) || tag.replace(/^v/, '') || tag;
    // Android versionCode scheme: major*10000 + minor*100 + patch
    // (1.0.8 → 10008, 2.0.0 → 20000) — matches build.gradle/appVersion.ts.
    const versionMatch = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
    const versionCode = versionMatch
      ? Number(versionMatch[1]) * 10000 + Number(versionMatch[2]) * 100 + Number(versionMatch[3])
      : 0;
    return {
      version,
      versionCode,
      apkUrl: apk?.browser_download_url || FALLBACK_URL,
      releasePage: data.html_url || FALLBACK_URL,
      releaseNotes: data.body || '',
      publishedAt: data.published_at || null,
    };
  } catch {
    return null;
  }
}

function fromEnv(): LatestRelease | null {
  const url = process.env.ATX_LATEST_APK_URL;
  const version = process.env.ATX_LATEST_VERSION;
  if (!url || !version) return null;
  return {
    version,
    versionCode: Number(process.env.ATX_LATEST_VERSION_CODE || 0),
    apkUrl: url,
    releasePage: url,
    releaseNotes: process.env.ATX_LATEST_NOTES || '',
    publishedAt: null,
  };
}

export async function handleAppLatest(_req: Request, res: Response) {
  try {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
      res.json({ ...cache.data, cached: true });
      return;
    }
    const data = fromEnv() || (await fetchFromGitHub());
    if (!data) {
      // No release metadata available — still hand back the releases page so
      // the client can offer a manual check.
      res.json({
        version: null,
        versionCode: 0,
        apkUrl: FALLBACK_URL,
        releasePage: FALLBACK_URL,
        releaseNotes: '',
        publishedAt: null,
      });
      return;
    }
    cache = { at: Date.now(), data };
    res.json({ ...data, cached: false });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}
