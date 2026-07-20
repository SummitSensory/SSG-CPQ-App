import { ForbiddenError } from '../lib/errors.js';
import { ROLE_PERMISSIONS, type Role } from './permissions.js';

export type { Role } from './permissions.js';

export function can(role: Role, permission: string): boolean {
  const granted = ROLE_PERMISSIONS[role] ?? [];
  return granted.includes('*') || granted.includes(permission);
}

export function assertCan(role: Role, permission: string): void {
  if (!can(role, permission)) {
    throw new ForbiddenError(`Role ${role} lacks permission ${permission}`);
  }
}
