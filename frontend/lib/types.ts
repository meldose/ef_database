export type AltegroRole =
  | 'platform_admin'
  | 'data_admin'
  | 'support_admin'
  | 'owner'
  | 'technician'
  | 'auditor'
  | 'robot_user';

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: AltegroRole;
  permissions: string[];
}

export interface OperationsSummary {
  robots: { total: number; active: number; draft: number; online: number; offline: number };
  events: { total: number; activeErrors: number; maintenanceDue: number };
  service: { total: number; open: number; closed: number };
  passport: { complete: number; percentage: number; certificatesDue: number };
  generatedAt: string;
}

export interface RobotSummary {
  id: string;
  serialNumber: string;
  status: string;
  online?: boolean | null;
  battery?: number | null;
  modelId: string;
  siteId: string;
  externalIdentities?: Array<{ system: string; externalId: string }>;
}

export interface AdapterSummary {
  provider: string;
  status: string;
  lastSyncAt?: string | null;
  lastSyncStatus?: string;
  capabilities: { read: string[]; event: string[]; command: string[] };
}

export interface OperationsReport {
  period: { days: number; from: string; to: string };
  fleet: {
    total: number;
    online: number;
    offline: number;
    availabilityPercent: number | null;
    averageBattery: number | null;
    lowBattery: number;
    attentionRobots: number;
    healthScore: number | null;
    providers: Array<{ provider: string; count: number }>;
  };
  tasks: {
    total: number;
    completed: number;
    failed: number;
    running: number;
    successRate: number | null;
    cleanedArea: number;
    averageDurationMinutes: number | null;
  };
  service: {
    casesOpened: number;
    casesClosed: number;
    caseClosureRate: number | null;
    averageResolutionHours: number | null;
    schedules: number;
    overdue: number;
  };
  maintenance: { predictedAttention: number; predictedHighRisk: number; highestRiskScore: number };
  workforce: { technicians: number; available: number; onLeave: number; availabilityPercent: number | null };
  events: { total: number; critical: number; errors: number; incidentsPerRobot: number | null };
  daily: Array<{ date: string; events: number; errors: number; maintenance: number; tasks: number }>;
  generatedAt: string;
}

export interface MaintenancePrediction {
  robotId: string;
  serialNumber: string;
  provider: string;
  score: number;
  risk: 'low' | 'medium' | 'high' | 'critical';
  predictedWindowDays: number;
  factors: string[];
  recommendedAction: string;
  generatedAt: string;
}

export interface NotificationWorkflow {
  status: 'open' | 'acknowledged' | 'snoozed' | 'resolved';
  technicianId: string | null;
  technicianName: string | null;
  note: string;
  snoozeUntil: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface OperationalNotification {
  id: string;
  type: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  title: string;
  message: string;
  robotId: string | null;
  occurredAt: string;
  read: boolean;
  readAt: string | null;
  workflow: NotificationWorkflow;
}

export interface MaintenanceSchedule {
  id: string;
  robotId: string;
  robotSerialNumber: string;
  title: string;
  description: string;
  intervalDays: number;
  reminderDays: number;
  nextDueAt: string;
  priority: 'low' | 'normal' | 'high' | 'critical';
  assignedTechnicianId: string | null;
  technicianName: string | null;
  status: 'active' | 'paused' | 'cancelled';
  dueState: 'scheduled' | 'due_soon' | 'overdue' | 'paused' | 'cancelled';
  reminderState: string;
  daysUntilDue: number | null;
  lastCompletedAt: string | null;
}

export interface AuditEntry {
  id: string;
  occurredAt: string;
  actorId: string;
  actorName: string;
  action: string;
  objectType: string;
  objectId: string;
  result: string;
  details?: Record<string, unknown>;
}

export interface AuditFacets {
  actions: string[];
  actors: Array<{ id: string; name: string }>;
  objectTypes: string[];
  results: string[];
}
