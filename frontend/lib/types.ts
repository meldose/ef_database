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
}

export interface AdapterSummary {
  provider: string;
  status: string;
  lastSyncAt?: string | null;
  lastSyncStatus?: string;
  capabilities: { read: string[]; event: string[]; command: string[] };
}
