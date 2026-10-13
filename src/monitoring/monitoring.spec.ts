import { HttpException, Logger, type ArgumentsHost } from '@nestjs/common';

import { HealthController } from '../health/health.controller.js';
import { redact, requestIdFrom } from './monitoring-rules.js';
import { ServerErrorFilter } from './server-error.filter.js';

/** A7.4 Error monitoring and health, the parts with no database. */

describe('requestIdFrom (A7.4)', () => {
  it('keeps a well-formed id the client sent, and makes one otherwise', () => {
    expect(requestIdFrom('app-1234abcd')).toBe('app-1234abcd');
    for (const bad of [undefined, '', 'short', 'not ok!', 'a\nb-1234567', 'x'.repeat(65)]) {
      expect(requestIdFrom(bad)).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
  });
});

describe('redact (A7.4)', () => {
  it('removes email addresses, then cuts to the length', () => {
    expect(redact('Failed for ana.lopez+x@mail.example.com and bo@x.io', 100)).toBe(
      'Failed for [email] and [email]',
    );
    expect(redact('a'.repeat(10), 4)).toBe('aaaa');
  });
});

describe('ServerErrorFilter (A7.4)', () => {
  function host(requestId = 'req-12345678') {
    const response = {
      statusCode: 0,
      body: undefined as unknown,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(body: unknown) {
        this.body = body;
        return this;
      },
    };
    const request = { method: 'GET', originalUrl: '/me/home?x=1', requestId };
    const context = {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    } as unknown as ArgumentsHost;
    return { context, response };
  }

  it('answers an unexpected error with 500 and the request id, logging one structured line', () => {
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { context, response } = host();
    new ServerErrorFilter().catch(new TypeError('cannot read stage of undefined'), context);
    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Something went wrong on our side.',
      requestId: 'req-12345678',
    });
    expect(log).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(log.mock.calls[0]![0])) as Record<string, unknown>;
    expect(line).toMatchObject({
      requestId: 'req-12345678',
      method: 'GET',
      path: '/me/home',
      error: 'TypeError',
      message: 'cannot read stage of undefined',
    });
    expect(typeof line['stack']).toBe('string');
    log.mockRestore();
  });

  it('leaves expected refusals as they are', () => {
    const { context, response } = host();
    const refusal = new HttpException({ statusCode: 404, message: 'Not here.' }, 404);
    new ServerErrorFilter().catch(refusal, context);
    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({ statusCode: 404, message: 'Not here.' });
  });
});

describe('readiness (A7.4)', () => {
  it('says the database is unavailable with 503 when it does not answer', async () => {
    const down = { $queryRaw: () => Promise.reject(new Error('connection refused')) };
    const controller = new HealthController(down as never);
    await expect(controller.ready()).rejects.toMatchObject({
      status: 503,
      response: { status: 'unavailable', database: 'unavailable' },
    });
  });
});
