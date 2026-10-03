import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';

// Error bodies carry a stable machine `code`, as the sessions endpoints do.

export function unprocessable(code: string, message: string): UnprocessableEntityException {
  return new UnprocessableEntityException({
    statusCode: 422,
    error: 'Unprocessable Entity',
    message,
    code,
  });
}

export function conflict(code: string, message: string): ConflictException {
  return new ConflictException({ statusCode: 409, error: 'Conflict', message, code });
}

export function notFound(code: string, message: string): NotFoundException {
  return new NotFoundException({ statusCode: 404, error: 'Not Found', message, code });
}
