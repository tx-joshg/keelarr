export class KeelarrError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "KeelarrError";
    this.statusCode = options.statusCode || 500;
    this.details = options.details || null;
  }
}

