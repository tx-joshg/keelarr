export class StackarrError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "StackarrError";
    this.statusCode = options.statusCode || 500;
    this.details = options.details || null;
  }
}

