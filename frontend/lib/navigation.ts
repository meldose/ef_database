import type { AltegroRole } from './types';

export type Workspace = 'overview' | 'robots' | 'service' | 'support' | 'workforce' | 'reports' | 'audit' | 'integrations' | 'administration';

export interface NavigationItem {
  id: Workspace;
  label: string;
  roles?: AltegroRole[];
}

export const navigation: NavigationItem[] = [
  { id:'overview',label:'Overview' },
  { id:'robots',label:'Robots' },
  { id:'service',label:'Events & service' },
  { id:'support',label:'Support' },
  { id:'workforce',label:'Technicians',roles:['platform_admin','data_admin','support_admin','technician','owner'] },
  { id:'reports',label:'Reports' },
  { id:'audit',label:'Audit log',roles:['platform_admin','data_admin','support_admin','owner','technician','auditor'] },
  { id:'integrations',label:'Integrations',roles:['platform_admin','data_admin','support_admin'] },
  { id:'administration',label:'Administration',roles:['platform_admin','data_admin','support_admin'] }
];

export function navigationForRole(role: AltegroRole): NavigationItem[] {
  return navigation.filter((item) => !item.roles || item.roles.includes(role));
}

export function legacyWorkspacePath(workspace: Workspace): string {
  if (workspace === 'service') return '/dashboard/operations';
  if (workspace === 'audit') return '/dashboard/administration';
  return `/dashboard/${workspace}`;
}
