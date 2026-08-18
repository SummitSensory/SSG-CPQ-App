/** Base for all expected, HTTP-mappable application errors. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed') {
    super(message, 400, 'VALIDATION_ERROR');
  }
}
export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401, 'UNAUTHORIZED');
  }
}
export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 403, 'FORBIDDEN');
  }
}
export class ConflictError extends AppError {
  constructor(message = 'Conflict') {
    super(message, 409, 'CONFLICT');
  }
}
export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(message, 404, 'NOT_FOUND');
  }
}
/**
 * A dependency the request needed is temporarily unreachable.
 *
 * Added for the live-account check in `plugins/authz.ts`: when the database cannot be
 * reached, that check must fail CLOSED, but it must not claim the caller's token is
 * bad. A 401 would sign every user out of a working session over an outage that has
 * nothing to do with their credentials; a 500 would report a bug that does not exist.
 * 503 says what is true — try again shortly — and keeps the authorization decision
 * from being made on unverified data.
 */
export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable') {
    super(message, 503, 'SERVICE_UNAVAILABLE');
  }
}
