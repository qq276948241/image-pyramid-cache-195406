/*!
  Stable error codes for the pyramid subsystem.

  Every rejection produced by the public pipeline surfaces one of these codes
  via `error.code`; the codes are part of the contract and must not be renamed.
*/

export const ErrorCode = Object.freeze({
  INPUT_EMPTY: 'PYR_INPUT_EMPTY',
  INPUT_TOO_LARGE: 'PYR_INPUT_TOO_LARGE',
  INPUT_UNREADABLE: 'PYR_INPUT_UNREADABLE',
  INPUT_CORRUPT: 'PYR_INPUT_CORRUPT',
  INPUT_UNSUPPORTED: 'PYR_INPUT_UNSUPPORTED',
  INPUT_DIMENSION_MISMATCH: 'PYR_INPUT_DIMENSION_MISMATCH',
  OPTION_INVALID: 'PYR_OPTION_INVALID',
  FRAME_FAILED: 'PYR_FRAME_FAILED',
  CACHE_CORRUPT: 'PYR_CACHE_CORRUPT',
  CACHE_IO: 'PYR_CACHE_IO',
  SERVICE_BUSY: 'PYR_SERVICE_BUSY',
  SERVICE_SHUTTING_DOWN: 'PYR_SERVICE_SHUTTING_DOWN',
  JOB_NOT_FOUND: 'PYR_JOB_NOT_FOUND',
  INTERNAL: 'PYR_INTERNAL',
});

/**
 * Typed error with a stable code. `cause` preserves the underlying library error.
 */
export class PyramidError extends Error {
  /**
   * @param {string} code one of ErrorCode
   * @param {string} message human-readable, deterministic message
   * @param {{ cause?: unknown, details?: Record<string, unknown> }} [extra]
   */
  constructor (code, message, { cause, details } = {}) {
    super(message);
    this.name = 'PyramidError';
    this.code = code;
    if (details !== undefined) this.details = details;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Normalise any thrown value into a PyramidError with a stable code.
 * @param {unknown} err
 * @returns {PyramidError}
 */
export function toPyramidError (err) {
  if (err instanceof PyramidError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new PyramidError(ErrorCode.INTERNAL, message, { cause: err });
}
