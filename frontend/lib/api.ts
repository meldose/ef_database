import type { AdapterSummary, OperationsSummary, RobotSummary, SessionUser } from './types';

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...init.headers }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(payload.error?.message || payload.message || 'Request failed', response.status);
  return payload as T;
}

export const api = {
  session: () => request<{ user: SessionUser }>('/api/v1/auth/session'),
  login: (email: string, password: string) =>
    request<{ user: SessionUser }>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    }),
  logout: () => request<{ loggedOut: boolean }>('/api/v1/auth/logout', { method: 'POST', body: '{}' }),
  summary: () => request<{ data: OperationsSummary }>('/api/v1/operations/summary'),
  robots: () => request<{ data: RobotSummary[]; count: number }>('/api/v1/robots?page=1&pageSize=8&sort=updatedAt:desc'),
  adapters: () => request<{ data: AdapterSummary[] }>('/api/v1/adapters')
};
