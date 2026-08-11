import type { NextFunction, Request, Response } from 'express';

export function mutationsAllowed(): boolean {
  return process.env.LEOCODEBOX_LOCAL_ONLY === '1'
    || (process.env.NODE_ENV === 'test' && Boolean(process.env.LEOCODEBOX_TEST_HOME));
}

export function requireLocalOnly(_req: Request, res: Response, next: NextFunction): void {
  if (!mutationsAllowed()) {
    res.status(403).json({ success: false, code: 'LOCAL_DESKTOP_REQUIRED', error: 'This operation is available only in local desktop mode.' });
    return;
  }
  next();
}
