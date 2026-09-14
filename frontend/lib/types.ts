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

export interface Attachment { name: string; contentType: string; size: number; sha256: string }
export interface AttachmentInput { name: string; contentType: string; contentBase64: string }
export interface EvidenceRecord { id: string; title: string; description?: string; createdAt: string; status?: string; version?: string; issuer?: string; validUntil?: string; attachment?: Attachment | null }
export interface SupportTicket {
  id: string; robotId: string; robotSerialNumber: string; externalId: string; title: string; description: string; category: string; severity: string; status: string; updatedAt: string;
  messages: Array<{ id: string; authorName: string; authorRole: string; message: string; createdAt: string; attachment?: Attachment | null }>;
}
export interface RobotPassportData {
  robot: RobotSummary; model: { name?: string }; owner: { name?: string }; operator: { name?: string }; site: { name?: string };
  entries: Array<{ id: string; type: string; source: string; occurredAt?: string; createdAt?: string; data: Record<string, unknown> }>;
  documents: EvidenceRecord[]; certificates: EvidenceRecord[]; deployments: EvidenceRecord[]; serviceCases: SupportTicket[];
  compatibility: Array<{ id: string; capability: string; status: string; evidence: string }>;
  workforce: { requirements: Record<string, unknown>; assignedTechnicians: Array<{ technician: { id: string; name: string }; eligibility: { eligible: boolean } }> };
  completeness: { percentage: number; checks: Record<string, boolean> };
}
export interface Technician {
  id: string; name: string; email: string; jobTitle: string; status: string;
  skills: Array<{ code: string; level: string }>; certificates: Array<{ type: string; issuer: string; validUntil: string }>;
  availability: { status: string; workingDays: string[]; dailyCapacityHours: number; notes?: string };
}
export interface WorkforceMatrix {
  technicians: Technician[]; permissions: { manage: boolean };
  rows: Array<{ robot: { id: string }; technician: { id: string }; eligibility: { eligible: boolean; missingSkills: string[]; missingCertificates: string[] } }>;
}
export interface WorkOrder { id: string; robotId: string; technicianId: string; robotSerialNumber: string; technicianName: string; title: string; description: string; priority: string; status: string; startsAt: string; endsAt: string; completionNote?: string }
export interface ComparisonMetrics { events: number; incidents: number; casesOpened: number; casesClosed: number; maintenanceCompleted: number }
export interface FleetComparisonData {
  groupBy: 'site' | 'provider'; days: number; currentPeriod: { from: string; to: string }; previousPeriod: { from: string; to: string };
  data: Array<{ id: string; label: string; robots: number; online: number; current: ComparisonMetrics; previous: ComparisonMetrics; change: ComparisonMetrics }>;
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
