import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';

import type { RequestWithId } from './request-id.middleware.js';

/**
 * A7.4 Every HTTP error leaves through here. Expected refusals (`HttpException`) answer as Nest
 * would. Anything else answers a calm 500 with the request id, and is logged as one structured
 * line with the request id, the route, and the stack; never the body, which may hold personal data.
 */
@Catch()
export class ServerErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('ServerError');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      response
        .status(exception.getStatus())
        .json(
          typeof body === 'string' ? { statusCode: exception.getStatus(), message: body } : body,
        );
      return;
    }
    const request = http.getRequest<RequestWithId>();
    const error = exception instanceof Error ? exception : new Error(String(exception));
    this.logger.error(
      JSON.stringify({
        requestId: request.requestId,
        method: request.method,
        path: request.originalUrl.split('?')[0],
        error: error.name,
        message: error.message,
        stack: error.stack,
      }),
    );
    response.status(500).json({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Something went wrong on our side.',
      requestId: request.requestId,
    });
  }
}
