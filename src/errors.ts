export type Reason =
  | 'unauthenticated'
  | 'feature_unsupported'
  | 'permission_denied'
  | 'stale_geometry'
  | 'stale_handle'
  | 'stale_snapshot'
  | 'would_require_activation'
  | 'target_unavailable'
  | 'path_not_found'
  | 'checksum_mismatch'
  | 'invalid_request'
  | 'limit_exceeded'
  | 'rate_limited'
  | 'internal';

export const REASON_STATUS: Record<Reason, number> = {
  unauthenticated: 401,
  feature_unsupported: 501,
  permission_denied: 403,
  stale_geometry: 409,
  stale_handle: 409,
  stale_snapshot: 409,
  would_require_activation: 422,
  target_unavailable: 404,
  path_not_found: 404,
  checksum_mismatch: 422,
  invalid_request: 400,
  limit_exceeded: 413,
  rate_limited: 429,
  internal: 500,
};

export class ApiError extends Error {
  readonly reason: Reason;
  readonly feature?: string;
  readonly retryAfterMs?: number;

  constructor(reason: Reason, message: string, opts: { feature?: string; retryAfterMs?: number } = {}) {
    super(message);
    this.name = 'ApiError';
    this.reason = reason;
    this.feature = opts.feature;
    this.retryAfterMs = opts.retryAfterMs;
  }

  get status(): number {
    return REASON_STATUS[this.reason];
  }

  toBody() {
    return {
      error: {
        reason: this.reason,
        message: this.message,
        ...(this.feature ? { feature: this.feature } : {}),
        ...(this.retryAfterMs !== undefined ? { retry_after_ms: this.retryAfterMs } : {}),
      },
    };
  }
}

export const unsupported = (feature: string, message: string) =>
  new ApiError('feature_unsupported', message, { feature });

/** Normalize any thrown value into an ApiError. */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  const e = err as { statusCode?: number; validation?: unknown; message?: string; code?: string };
  if (e && e.validation) return new ApiError('invalid_request', e.message ?? 'invalid request');
  if (e && e.code === 'ENOENT') return new ApiError('path_not_found', e.message ?? 'not found');
  if (e && (e.code === 'EACCES' || e.code === 'EPERM')) return new ApiError('permission_denied', e.message ?? 'denied');
  if (e && e.statusCode === 413) return new ApiError('limit_exceeded', e.message ?? 'too large');
  if (e && e.statusCode === 404) return new ApiError('target_unavailable', e.message ?? 'not found');
  if (e && typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500)
    return new ApiError('invalid_request', e.message ?? 'bad request');
  return new ApiError('internal', (e && e.message) || 'internal error');
}
