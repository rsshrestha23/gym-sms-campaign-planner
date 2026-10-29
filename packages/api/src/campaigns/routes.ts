import { Router } from 'express';
import { asyncHandler, parsePositiveInt } from '../http';
import { SEND_STATUSES, SendStatus } from '../sends/status-transition';
import { CampaignNotFoundError, CampaignRepository } from './repository';

export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 1000;

export function campaignRoutes(repo: CampaignRepository): Router {
  const router = Router();

  router.post(
    '/campaigns/:id/plan',
    asyncHandler(async (req, res) => {
      const id = parsePositiveInt(req.params.id);
      if (id === undefined) return res.status(400).json({ error: 'invalid_campaign_id' });
      try {
        const { created, summary } = await repo.plan(id);
        // 201 when this call created the plan, 200 when it returned the existing immutable plan.
        res.status(created ? 201 : 200).json({ campaignId: id, created, ...summary });
      } catch (err) {
        if (err instanceof CampaignNotFoundError) return res.status(404).json({ error: 'campaign_not_found' });
        throw err;
      }
    }),
  );

  router.get(
    '/campaigns/:id/summary',
    asyncHandler(async (req, res) => {
      const id = parsePositiveInt(req.params.id);
      if (id === undefined) return res.status(400).json({ error: 'invalid_campaign_id' });
      const summary = await repo.summary(id);
      if (!summary) return res.status(404).json({ error: 'campaign_not_found' });
      res.json(summary);
    }),
  );

  router.get(
    '/campaigns/:id/sends',
    asyncHandler(async (req, res) => {
      const id = parsePositiveInt(req.params.id);
      if (id === undefined) return res.status(400).json({ error: 'invalid_campaign_id' });

      const errors: string[] = [];
      const read = (name: string): string | undefined => {
        const v = req.query[name];
        if (v === undefined || v === '') return undefined;
        if (typeof v !== 'string') {
          errors.push(name);
          return undefined;
        }
        return v;
      };

      const rawBranch = read('branchId');
      const rawStatus = read('status');
      const rawCursor = read('cursor');
      const rawLimit = read('limit');

      const branchId = rawBranch === undefined ? undefined : parsePositiveInt(rawBranch);
      if (rawBranch !== undefined && branchId === undefined) errors.push('branchId');
      const status = rawStatus as SendStatus | undefined;
      if (status !== undefined && !SEND_STATUSES.includes(status)) errors.push('status');
      const cursor = rawCursor === undefined ? undefined : parsePositiveInt(rawCursor);
      if (rawCursor !== undefined && cursor === undefined) errors.push('cursor');
      const limit = rawLimit === undefined ? DEFAULT_PAGE_SIZE : parsePositiveInt(rawLimit);
      if (limit === undefined || limit > MAX_PAGE_SIZE) errors.push('limit');

      if (errors.length) {
        return res.status(400).json({ error: 'invalid_query', fields: [...new Set(errors)], maxLimit: MAX_PAGE_SIZE });
      }
      if (!(await repo.exists(id))) return res.status(404).json({ error: 'campaign_not_found' });

      res.json(await repo.listSends(id, { branchId, status, cursor, limit: limit! }));
    }),
  );

  return router;
}
