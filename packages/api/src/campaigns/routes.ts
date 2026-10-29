import { Router } from 'express';
import { asyncHandler, parsePositiveInt } from '../http';
import { SEND_STATUSES, SendStatus } from '../sends/status-transition';
import { capacityReport } from './capacity';
import { PlanRunCampaignNotFound } from './plan-run-repository';
import { CampaignNotFoundError, CampaignRepository } from './repository';

export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 1000;

export function campaignRoutes(repo: CampaignRepository): Router {
  const router = Router();

  /**
   * Synchronous by default (201 created / 200 existing, with counts), as the original API requires.
   * With `Prefer: respond-async` (or ?async=true) it returns 202 { planRunId, status } immediately
   * and plans in the background; poll GET /campaigns/:id/plan-runs/:planRunId for progress.
   */
  router.post(
    '/campaigns/:id/plan',
    asyncHandler(async (req, res) => {
      const id = parsePositiveInt(req.params.id);
      if (id === undefined) return res.status(400).json({ error: 'invalid_campaign_id' });
      const wantsAsync = /\brespond-async\b/i.test(req.get('prefer') ?? '') || req.query.async === 'true';
      try {
        if (wantsAsync) {
          const { run, created } = await repo.planner.start(id);
          if (run.status !== 'completed') {
            // Fire and forget; the advisory lock makes this a no-op if another instance is executing.
            repo.planner.execute(run.id).catch((err) => console.error(`plan run ${run.id} failed`, err));
          }
          res.setHeader('Location', `${req.baseUrl}/campaigns/${id}/plan-runs/${run.id}`);
          res.setHeader('Preference-Applied', 'respond-async');
          return res.status(run.status === 'completed' ? 200 : 202).json({
            campaignId: id,
            planRunId: run.id,
            status: run.status === 'failed' ? 'queued' : run.status,
            created,
          });
        }
        const { created, summary } = await repo.plan(id);
        // 201 when this call created the plan, 200 when it returned the existing immutable plan.
        res.status(created ? 201 : 200).json({ campaignId: id, created, ...summary });
      } catch (err) {
        if (err instanceof CampaignNotFoundError || err instanceof PlanRunCampaignNotFound) {
          return res.status(404).json({ error: 'campaign_not_found' });
        }
        throw err;
      }
    }),
  );

  router.get(
    '/campaigns/:id/plan-runs/:planRunId',
    asyncHandler(async (req, res) => {
      const id = parsePositiveInt(req.params.id);
      const runId = parsePositiveInt(req.params.planRunId);
      if (id === undefined || runId === undefined) return res.status(400).json({ error: 'invalid_id' });
      const run = await repo.planner.getRun(runId, id);
      if (!run) return res.status(404).json({ error: 'plan_run_not_found' });
      res.json(run);
    }),
  );

  router.get(
    '/campaigns/:id/capacity',
    asyncHandler(async (req, res) => {
      const id = parsePositiveInt(req.params.id);
      if (id === undefined) return res.status(400).json({ error: 'invalid_campaign_id' });
      const report = await capacityReport(repo.pool, id);
      if (!report) return res.status(404).json({ error: 'campaign_not_found' });
      res.json(report);
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
