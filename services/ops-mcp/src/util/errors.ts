export class UserFacingError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

export class PathRejectedError extends UserFacingError {
  constructor(reason: string) {
    super(`Path rejected: ${reason}`, "path_rejected");
  }
}

export class ConflictError extends UserFacingError {
  constructor(message: string) {
    super(message, "conflict");
  }
}
