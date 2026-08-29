export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends CliError {
  constructor(message: string, details?: unknown) {
    super(message, 2, details);
  }
}

export class AuthenticationError extends CliError {
  constructor(message: string) {
    super(message, 3);
  }
}

export class NetworkError extends CliError {
  constructor(message: string, details?: unknown) {
    super(message, 4, details);
  }
}

export class ApiError extends CliError {
  constructor(
    message: string,
    readonly apiCode: number,
    details?: unknown,
  ) {
    super(message, 5, details);
  }
}
