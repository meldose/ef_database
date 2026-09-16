import type {
  AttachmentInput, RobotPassportData, SupportTicket, WorkforceMatrix, WorkOrder, FleetComparisonData,
  AdapterSummary,
  AuditEntry,
  AuditFacets,
  MaintenancePrediction,
  MaintenanceSchedule,
  OperationalNotification,
  OperationsReport,
  OperationsSummary,
  ReportSubscription,
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

export interface ReportSubscriptionInput {
  name: string;
  cadence: ReportSubscription['cadence'];
  days: ReportSubscription['days'];
  hourUtc: number;
  weekday: number;
  monthDay: number;
  active?: boolean;
}

export const api = {
  passport: (id: string) => request<{ data: RobotPassportData }>(`/api/v1/robots/${encodeURIComponent(id)}/passport`),
  addDocument: (id: string, input: { title: string; description: string; attachment?: AttachmentInput }) => request(`/api/v1/robots/${encodeURIComponent(id)}/lifecycle-records`, { method: 'POST', body: JSON.stringify({ recordType: 'document', ...input }) }),
  tickets: () => request<{ data: SupportTicket[]; permissions: { create: boolean; reply: boolean; manage: boolean } }>('/api/v1/support/tickets'),
  createTicket: (input: { robotId: string; title: string; description: string; category: string; severity: string; attachment?: AttachmentInput }) => request<{ data: SupportTicket }>('/api/v1/support/tickets', { method: 'POST', body: JSON.stringify(input) }),
  replyTicket: (id: string, input: { message: string; status?: string; attachment?: AttachmentInput }) => request<{ data: SupportTicket }>(`/api/v1/support/tickets/${encodeURIComponent(id)}/messages`, { method: 'POST', body: JSON.stringify(input) }),
  workforce: () => request<{ data: WorkforceMatrix }>('/api/v1/workforce/matrix'),
  workOrders: () => request<{ data: WorkOrder[]; permissions: { manage: boolean; updateAssigned: boolean } }>('/api/v1/work-orders'),
  createWorkOrder: (input: { robotId: string; technicianId: string; title: string; startsAt: string; endsAt: string; description: string; priority: string }) => request('/api/v1/work-orders', { method: 'POST', body: JSON.stringify(input) }),
  updateWorkOrder: (id: string, status: string, completionNote: string) => request(`/api/v1/work-orders/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ status, completionNote }) }),
  updateAvailability: (id: string, availability: { status: string; workingDays: string[]; dailyCapacityHours: number; notes?: string }) => request(`/api/v1/technicians/${encodeURIComponent(id)}/availability`, { method: 'PATCH', body: JSON.stringify(availability) }),
  addQualification: (id: string, input: { kind: string; code: string; issuer?: string; validUntil?: string }) => request(`/api/v1/technicians/${encodeURIComponent(id)}/qualifications`, { method: 'POST', body: JSON.stringify(input) }),
  fleetComparison: (groupBy: 'site' | 'provider', days: number) => request<{ data: FleetComparisonData }>(withQuery('/api/v1/reports/comparison', { groupBy, days })),
  session: () => request<{ user: SessionUser }>('/api/v1/auth/session'),
  login: (email: string, password: string) =>
    request<{ user: SessionUser }>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    }),
  logout: () => request<{ loggedOut: boolean }>('/api/v1/auth/logout', { method: 'POST', body: '{}' }),
  summary: () => request<{ data: OperationsSummary }>('/api/v1/operations/summary'),
  robots: async () => {
    const data: RobotSummary[] = []; let page = 1; let totalPages = 1;
    do { const result = await request<{ data: RobotSummary[]; pagination: { pageCount: number } }>(`/api/v1/robots?page=${page}&pageSize=100&sort=updatedAt&order=desc`); data.push(...result.data); totalPages = result.pagination.pageCount; page += 1; } while (page <= totalPages);
    return { data: [...new Map(data.map((robot) => [robot.id, robot])).values()], count: data.length };
  },
  adapters: () => request<{ data: AdapterSummary[] }>('/api/v1/adapters'),
  operationsReport: (days: number) => request<{ data: OperationsReport }>(withQuery('/api/v1/reports/operations', { days })),
  reportSubscriptions: () => request<{ data: ReportSubscription[]; count: number; delivery: { enabled: boolean; configured: boolean; configurationError: string | null } }>('/api/v1/report-subscriptions'),
  createReportSubscription: (input: ReportSubscriptionInput) => request<{ data: ReportSubscription }>('/api/v1/report-subscriptions', { method: 'POST', body: JSON.stringify(input) }),
  updateReportSubscription: (id: string, input: Partial<ReportSubscriptionInput>) => request<{ data: ReportSubscription }>(`/api/v1/report-subscriptions/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  sendReportNow: (id: string) => request<{ data: ReportSubscription; delivery: { id: string; status: string; sentAt: string; recipientCount: number } }>(`/api/v1/report-subscriptions/${encodeURIComponent(id)}/send-now`, { method: 'POST', body: '{}' }),
  deleteReportSubscription: (id: string) => request<{ deleted: boolean; id: string }>(`/api/v1/report-subscriptions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  maintenancePredictions: () => request<{ data: MaintenancePrediction[]; summary: { total: number; critical: number; high: number; attention: number }; generatedAt: string }>('/api/v1/maintenance/predictions'),
  notifications: (filters: { q?: string; severity?: string; status?: string } = {}) => request<{ data: OperationalNotification[]; count: number; activeCount: number; unreadCount: number; generatedAt: string }>(withQuery('/api/v1/notifications', filters)),
  markNotificationsRead: (notificationIds: string[]) => request<{ readCount: number; unreadCount: number; readAt: string }>('/api/v1/notifications/read', { method: 'POST', body: JSON.stringify({ notificationIds }) }),
  updateNotification: (id: string, status: 'open' | 'acknowledged' | 'resolved') => request<{ data: OperationalNotification['workflow'] }>(`/api/v1/notifications/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  maintenanceSchedules: () => request<{ data: MaintenanceSchedule[]; count: number; permissions: { manage: boolean } }>('/api/v1/maintenance-schedules'),
  createMaintenanceSchedule: (input: MaintenanceScheduleInput) => request<{ data: MaintenanceSchedule }>('/api/v1/maintenance-schedules', { method: 'POST', body: JSON.stringify(input) }),
  updateMaintenanceSchedule: (id: string, input: { status?: 'active' | 'paused' | 'cancelled'; complete?: boolean; completionNote?: string }) => request<{ data: MaintenanceSchedule }>(`/api/v1/maintenance-schedules/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  audit: (filters: AuditFilters = {}) => request<{ data: AuditEntry[]; count: number; total: number; facets: AuditFacets; generatedAt: string }>(withQuery('/api/v1/audit', { limit: 100, ...filters }))
};
