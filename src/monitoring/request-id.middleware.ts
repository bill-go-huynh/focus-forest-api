import type { NextFunction, Request, Response } from 'express';

import { requestIdFrom } from './monitoring-rules.js';

export type RequestWithId = Request & { requestId?: string };

/**
 * A7.4 Every response carries `X-Request-Id`: the client's when well formed, else a new one. A
 * person or the app can quote it, and the server error log line has it.
 */
export function requestId(request: RequestWithId, response: Response, next: NextFunction): void {
  const id = requestIdFrom(request.header('x-request-id'));
  request.requestId = id;
  response.setHeader('X-Request-Id', id);
  next();
}
