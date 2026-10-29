import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Forwards async rejections to Express's error handler. */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value)) return undefined;
  const n = Number(value);
  return n <= 2_147_483_647 ? n : undefined;
}
