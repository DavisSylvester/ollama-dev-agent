import type { ApiResponse, ApiError } from '../types/index.mts';

export function ok<T>(data: T): ApiResponse<T> {
  return { ok: true, data, error: null };
}

export function fail(code: string, message: string, details?: unknown): ApiResponse<null> {
  const error: ApiError = details !== undefined ? { code, message, details } : { code, message };
  return { ok: false, data: null, error };
}
