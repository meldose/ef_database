import type {
  AdapterSummary,
  AuditEntry,
  AuditFacets,
  MaintenancePrediction,
  MaintenanceSchedule,
  OperationalNotification,
  OperationsReport,
  OperationsSummary,
  RobotSummary,
  SessionUser
} from './types';

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

export function withQuery(path: string, values: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== '') query.set(key, String(value));
  });
  const suffix = query.toString();
  return suffix ? `${path}?${suffix}` : path;
}

export interface AuditFilters {
  q?: string;
  action?: string;
  result?: string;
  actorId?: string;
  objectType?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export interface MaintenanceScheduleInput {
  robotId: string;
  title: string;
  nextDueAt: string;
  intervalDays: number;
  reminderDays: number;
  priority: MaintenanceSchedule['priority'];
  description?: string;
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
  robots: () => request<{ data: RobotSummary[]; count: number }>('/api/v1/robots?page=1&pageSize=100&sort=updatedAt&order=desc'),
  adapters: () => request<{ data: AdapterSummary[] }>('/api/v1/adapters'),
  operationsReport: (days: number) => request<{ data: OperationsReport }>(withQuery('/api/v1/reports/operations', { days })),
  maintenancePredictions: () => request<{ data: MaintenancePrediction[]; summary: { total: number; critical: number; high: number; attention: number }; generatedAt: string }>('/api/v1/maintenance/predictions'),
  notifications: (filters: { q?: string; severity?: string; status?: string } = {}) => request<{ data: OperationalNotification[]; count: number; activeCount: number; unreadCount: number; generatedAt: string }>(withQuery('/api/v1/notifications', filters)),
  markNotificationsRead: (notificationIds: string[]) => request<{ readCount: number; unreadCount: number; readAt: string }>('/api/v1/notifications/read', { method: 'POST', body: JSON.stringify({ notificationIds }) }),
  updateNotification: (id: string, status: 'open' | 'acknowledged' | 'resolved') => request<{ data: OperationalNotification['workflow'] }>(`/api/v1/notifications/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  maintenanceSchedules: () => request<{ data: MaintenanceSchedule[]; count: number; permissions: { manage: boolean } }>('/api/v1/autoxing/maintenance-schedules'),
  createMaintenanceSchedule: (input: MaintenanceScheduleInput) => request<{ data: MaintenanceSchedule }>('/api/v1/autoxing/maintenance-schedules', { method: 'POST', body: JSON.stringify(input) }),
  updateMaintenanceSchedule: (id: string, input: { status?: 'active' | 'paused' | 'cancelled'; complete?: boolean; completionNote?: string }) => request<{ data: MaintenanceSchedule }>(`/api/v1/autoxing/maintenance-schedules/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  audit: (filters: AuditFilters = {}) => request<{ data: AuditEntry[]; count: number; total: number; facets: AuditFacets; generatedAt: string }>(withQuery('/api/v1/audit', { limit: 100, ...filters }))
};
