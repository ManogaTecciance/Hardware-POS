import { api } from '@/lib/api';
import type { Session } from '@/lib/auth';
import type { BusinessType } from '@/lib/platform-api';

/**
 * D55 — the platform console API.
 *
 * Every endpoint here is administrative metadata. A platform admin's token is
 * refused by every other route in the product (`PlatformBoundaryGuard`), so
 * there is deliberately no way to reach a workspace's business data from this
 * client.
 */

export interface WorkspaceTemplate {
  key: string;
  name: string;
  description: string;
  businessType: BusinessType;
}

export interface WorkspaceView {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  templateKey: string | null;
  businessType: BusinessType | null;
  userCount: number;
  createdAt: string;
}

export interface WorkspaceUserView {
  id: string;
  name: string;
  email: string | null;
  /** The `UserRole` enum underneath. Not what grants authority — see `roleKey`. */
  role: string;
  isActive: boolean;
  /**
   * The workspace role in force, which is what `PermissionResolver` reads.
   * Null means the account resolves from the enum above instead — a real state
   * for users created before roles were rows.
   */
  roleId: string | null;
  roleKey: string | null;
}

/**
 * A role this workspace can assign. Which roles exist is decided by the
 * workspace's template — a restaurant or hotel workspace has Waiter, Kitchen
 * Staff and the rest on top of the five built-ins; a hardware one does not.
 * Addressed by `id` because `key` is nullable server-side.
 */
export interface WorkspaceRoleView {
  id: string;
  key: string | null;
  name: string;
  description: string | null;
  isSystem: boolean;
}

function auth(session: Session) {
  return { token: session.token, tenantId: session.user.tenantId };
}

export const platformAdmin = {
  templates(session: Session) {
    return api.get<WorkspaceTemplate[]>('/platform-admin/templates', auth(session));
  },
  listWorkspaces(session: Session, search?: string) {
    const q = search ? `?search=${encodeURIComponent(search)}` : '';
    return api.get<WorkspaceView[]>(`/platform-admin/workspaces${q}`, auth(session));
  },
  getWorkspace(session: Session, id: string) {
    return api.get<WorkspaceView>(`/platform-admin/workspaces/${id}`, auth(session));
  },
  createWorkspace(
    session: Session,
    body: {
      name: string;
      slug: string;
      templateKey: string;
      ownerName: string;
      ownerEmail: string;
      ownerPassword: string;
    },
  ) {
    return api.post<WorkspaceView>('/platform-admin/workspaces', body, auth(session));
  },
  updateWorkspace(session: Session, id: string, body: { name?: string; isActive?: boolean }) {
    return api.patch<WorkspaceView>(`/platform-admin/workspaces/${id}`, body, auth(session));
  },
  listRoles(session: Session, workspaceId: string) {
    return api.get<WorkspaceRoleView[]>(
      `/platform-admin/workspaces/${workspaceId}/roles`,
      auth(session),
    );
  },
  listUsers(session: Session, workspaceId: string) {
    return api.get<WorkspaceUserView[]>(
      `/platform-admin/workspaces/${workspaceId}/users`,
      auth(session),
    );
  },
  createUser(
    session: Session,
    workspaceId: string,
    body: { name: string; email: string; password: string; roleId: string },
  ) {
    return api.post<WorkspaceUserView>(
      `/platform-admin/workspaces/${workspaceId}/users`,
      body,
      auth(session),
    );
  },
  updateUser(
    session: Session,
    workspaceId: string,
    userId: string,
    body: { name?: string; roleId?: string; isActive?: boolean },
  ) {
    return api.patch<WorkspaceUserView>(
      `/platform-admin/workspaces/${workspaceId}/users/${userId}`,
      body,
      auth(session),
    );
  },
  /** Audited server-side: this lets the operator sign in as the user. */
  resetPassword(session: Session, workspaceId: string, userId: string, password: string) {
    return api.post<void>(
      `/platform-admin/workspaces/${workspaceId}/users/${userId}/password`,
      { password },
      auth(session),
    );
  },
};
