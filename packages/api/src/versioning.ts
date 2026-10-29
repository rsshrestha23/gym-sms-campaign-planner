import { Router } from 'express';

/**
 * Path-based API versioning.
 *
 * `/v1/...` is the canonical form. The original unprefixed paths (`/campaigns/...`,
 * `/webhooks/provider`) are a permanent alias pinned to v1, not "latest": a future v2 gets its own
 * prefix and never changes what an unversioned client or an already-configured provider webhook
 * URL receives. `/health` is infrastructure and stays unversioned.
 */
export const SUPPORTED_VERSIONS = ['v1'] as const;
export type ApiVersion = (typeof SUPPORTED_VERSIONS)[number];
export const UNVERSIONED_ALIAS: ApiVersion = 'v1';
export const API_VERSION_HEADER = 'API-Version';

export function mountVersions(versions: Record<ApiVersion, Router>): Router {
  const root = Router();

  for (const version of SUPPORTED_VERSIONS) {
    root.use(`/${version}`, (_req, res, next) => {
      res.setHeader(API_VERSION_HEADER, version);
      next();
    }, versions[version]);
  }

  // Any other /v<n> prefix is an unknown version, not an unknown resource.
  // (Checked by hand: Express 5 matches a RegExp `use` path against the whole URL, not a prefix.)
  root.use((req, res, next) => {
    const match = /^\/(v\d+)(?:\/|$)/.exec(req.path);
    if (!match) return next();
    // A supported version that matched no route is an ordinary 404; never retry it as an alias path.
    if ((SUPPORTED_VERSIONS as readonly string[]).includes(match[1])) return res.status(404).json({ error: 'not_found' });
    res.status(404).json({ error: 'unsupported_api_version', version: match[1], supportedVersions: SUPPORTED_VERSIONS });
  });

  root.use((_req, res, next) => {
    res.setHeader(API_VERSION_HEADER, UNVERSIONED_ALIAS);
    next();
  }, versions[UNVERSIONED_ALIAS]);

  return root;
}
