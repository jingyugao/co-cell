export class ApplicationError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApplicationError";
  }
}

export class NotFoundError extends ApplicationError {
  constructor(resource: string) {
    super(`${resource} was not found`, "not_found", 404);
  }
}

export class InvalidRequestError extends ApplicationError {
  constructor(message: string) {
    super(message, "invalid_request", 400);
  }
}

export class ConflictError extends ApplicationError {
  constructor(message: string) {
    super(message, "conflict", 409);
  }
}
