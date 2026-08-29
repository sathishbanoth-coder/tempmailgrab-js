/** Base class for every error this library throws. */
export class TempMailGrabError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TempMailGrabError';
  }
}

/** A non-2xx response from the API. */
export class ApiError extends TempMailGrabError {
  constructor(
    /** HTTP status code. */
    readonly status: number,
    /** The API's `error` field when present, otherwise the raw body. */
    readonly detail: string,
    /** The request that failed, e.g. "POST /api/v1/inbox". */
    readonly request: string,
  ) {
    super(`${request} failed with ${status}: ${detail}`);
    this.name = 'ApiError';
  }

  /** True when the key is missing, invalid, or lacks access. */
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }

  /** True when the per-key rate limit was exceeded — back off and retry. */
  get isRateLimited(): boolean {
    return this.status === 429;
  }
}

/**
 * A `waitFor*` call gave up before the message arrived.
 *
 * If you see this in CI, the useful question is whether the message was never
 * sent or merely slow — `messagesSeen` tells you which, without a second run.
 */
export class TimeoutError extends TempMailGrabError {
  constructor(
    message: string,
    /** How many messages DID land in the inbox before giving up. */
    readonly messagesSeen: number,
    readonly waitedMs: number,
  ) {
    super(message);
    this.name = 'TimeoutError';
  }
}
