import type * as T from "common/api-types";
import type * as B from "common/bases";
import type { Node } from "common/editor/model";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

const qs = (query?: Query) => {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "" || v === false) continue;
    params.set(k, v === true ? "1" : String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
};

let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

const request = async <R>(method: string, path: string, body?: unknown, query?: Query): Promise<R> => {
  const init: RequestInit = { method, credentials: "same-origin", headers: {} };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body instanceof Blob) {
    init.body = body;
    (init.headers as Record<string, string>)["Content-Type"] = body.type || "application/octet-stream";
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}${qs(query)}`, init);
  } catch {
    throw new ApiError(0, "network", "Could not reach the server. Check your connection.");
  }
  let payload: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!res.ok) {
    const err = (payload as T.ApiFailure | null)?.error;
    if (res.status === 401 && !path.startsWith("/auth/") && !path.startsWith("/public")) onUnauthorized?.();
    throw new ApiError(res.status, err?.code ?? "error", err?.message ?? `Request failed (${res.status})`);
  }
  return (payload as T.ApiSuccess<R>)?.data as R;
};

const get = <R>(path: string, query?: Query) => request<R>("GET", path, undefined, query);
const post = <R>(path: string, body?: unknown) => request<R>("POST", path, body ?? {});

const upload = <R>(path: string, fields: Record<string, string | Blob | undefined>) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) form.append(k, v);
  return request<R>("POST", path, form);
};

export const api = {
  setupStatus: () => get<T.SetupStatus>("/setup"),
  setup: (body: { workspaceName: string; name: string; email: string; password: string }) => post<T.UserResponse>("/setup", body),
  login: (email: string, password: string) => post<T.UserResponse>("/auth/login", { email, password }),
  logout: () => post<object>("/auth/logout"),
  forgotPassword: (email: string) => post<object>("/auth/forgot-password", { email }),
  resetPassword: (token: string, password: string) => post<T.UserResponse>("/auth/reset-password", { token, password }),
  changePassword: (currentPassword: string, newPassword: string) => post<object>("/auth/change-password", { currentPassword, newPassword }),
  sessions: () => get<T.SessionInfo[]>("/auth/sessions"),
  revokeSession: (id: string) => post<object>("/auth/sessions/revoke", { id }),

  me: () => get<T.MeResponse>("/me"),
  updateMe: (body: Partial<{ name: string; email: string; currentPassword: string; locale: string; timezone: string; preferences: T.UserPreferences }>) =>
    post<T.UserResponse>("/me/update", body),
  uploadAvatar: (file: File) => upload<T.UserResponse>("/me/avatar", { file }),
  removeAvatar: () => post<T.UserResponse>("/me/avatar/remove"),

  publicWorkspace: () => get<T.PublicWorkspace>("/workspace/public"),
  updateWorkspace: (body: Partial<{ name: string; description: string; emailDomains: string[]; settings: T.WorkspaceSettings }>) =>
    post<T.WorkspaceResponse>("/workspace/update", body),
  uploadLogo: (file: File) => upload<T.WorkspaceResponse>("/workspace/logo", { file }),
  removeLogo: () => post<T.WorkspaceResponse>("/workspace/logo/remove"),

  members: (query?: { query?: string; limit?: number; offset?: number }) => get<T.Paginated<T.Member>>("/members", query),
  changeRole: (userId: string, role: T.WorkspaceRole) => post<T.UserResponse>("/members/role", { userId, role }),
  deactivateMember: (userId: string) => post<object>("/members/deactivate", { userId }),
  activateMember: (userId: string) => post<object>("/members/activate", { userId }),
  deleteMember: (userId: string) => post<object>("/members/delete", { userId }),

  invitations: () => get<T.Invitation[]>("/invitations"),
  invite: (emails: string[], role: "admin" | "member", groupIds: string[]) => post<T.CreatedInvitation[]>("/invitations", { emails, role, groupIds }),
  resendInvitation: (id: string) => post<T.InvitationUrl>("/invitations/resend", { id }),
  invitationLink: (id: string) => post<T.InvitationUrl>("/invitations/link", { id }),
  revokeInvitation: (id: string) => post<object>("/invitations/revoke", { id }),
  invitationInfo: (id: string, token: string) => get<T.InvitationInfo>(`/invitations/${id}`, { token }),
  acceptInvitation: (body: { id: string; token: string; name: string; password: string }) => post<T.UserResponse>("/invitations/accept", body),

  groups: () => get<T.Group[]>("/groups"),
  createGroup: (name: string, description?: string) => post<{ group: T.Group }>("/groups", { name, description }),
  updateGroup: (id: string, body: { name?: string; description?: string }) => post<{ group: T.Group }>(`/groups/${id}/update`, body),
  deleteGroup: (id: string) => post<object>(`/groups/${id}/delete`),
  groupMembers: (id: string) => get<T.Paginated<T.User>>(`/groups/${id}/members`, { limit: 500 }),
  addGroupMembers: (id: string, userIds: string[]) => post<object>(`/groups/${id}/members/add`, { userIds }),
  removeGroupMember: (id: string, userId: string) => post<object>(`/groups/${id}/members/remove`, { userId }),

  spaces: () => get<T.Space[]>("/spaces"),
  allSpaces: () => get<T.Space[]>("/spaces/all"),
  createSpace: (body: { name: string; slug: string; description?: string }) => post<{ space: T.Space }>("/spaces", body),
  space: (idOrSlug: string) => get<{ space: T.Space }>(`/spaces/${encodeURIComponent(idOrSlug)}`),
  updateSpace: (id: string, body: Partial<{ name: string; slug: string; description: string; settings: T.SpaceSettings }>) =>
    post<{ space: T.Space }>(`/spaces/${id}/update`, body),
  deleteSpace: (id: string) => post<object>(`/spaces/${id}/delete`),
  uploadSpaceIcon: (id: string, file: File) => upload<{ space: T.Space }>(`/spaces/${id}/icon`, { file }),
  removeSpaceIcon: (id: string) => post<{ space: T.Space }>(`/spaces/${id}/icon/remove`),
  spaceMembers: (id: string) => get<T.SpaceMember[]>(`/spaces/${id}/members`),
  addSpaceMembers: (id: string, role: T.SpaceRole, userIds: string[], groupIds: string[]) =>
    post<object>(`/spaces/${id}/members/add`, { role, userIds, groupIds }),
  changeSpaceMemberRole: (id: string, memberId: string, role: T.SpaceRole) => post<object>(`/spaces/${id}/members/role`, { memberId, role }),
  removeSpaceMember: (id: string, memberId: string) => post<object>(`/spaces/${id}/members/remove`, { memberId }),
  spaceExportUrl: (id: string, format: "markdown" | "html", files: boolean) => `/api/spaces/${id}/export${qs({ format, files })}`,

  tree: (spaceId: string, parentId?: string | null) => get<T.TreeItem[]>(`/spaces/${spaceId}/pages`, { parentId: parentId ?? undefined }),
  page: (idOrSlug: string) => get<T.PageDetails>(`/pages/${encodeURIComponent(idOrSlug)}`),
  createPage: (body: { spaceId: string; parentId?: string | null; title?: string; icon?: string; content?: Node; afterId?: string | null }) =>
    post<T.PageResponse>("/pages", body),
  updatePage: (id: string, body: Partial<{ title: string; icon: string | null; cover: string | null }>) => post<T.PageResponse>(`/pages/${id}/update`, body),
  setPageContent: (id: string, content: Node) => post<T.PageResponse>(`/pages/${id}/content`, { content }),
  movePage: (id: string, parentId: string | null, afterId: string | null) => post<T.PageResponse>(`/pages/${id}/move`, { parentId, afterId }),
  movePageToSpace: (id: string, spaceId: string) => post<T.PageResponse>(`/pages/${id}/move-to-space`, { spaceId }),
  duplicatePage: (id: string, spaceId?: string) => post<T.PageResponse>(`/pages/${id}/duplicate`, { spaceId }),
  trashPage: (id: string) => post<object>(`/pages/${id}/delete`),
  restorePage: (id: string) => post<T.PageResponse>(`/pages/${id}/restore`),
  deletePagePermanently: (id: string) => post<object>(`/pages/${id}/delete-permanently`),
  trash: (spaceId: string) => get<T.TrashItem[]>(`/spaces/${spaceId}/trash`),
  recent: (query?: { spaceId?: string; creatorId?: string; limit?: number; offset?: number }) => get<T.RecentPage[]>("/pages/recent", query),
  versions: (pageId: string) => get<T.PageVersionSummary[]>(`/pages/${pageId}/versions`),
  version: (id: string) => get<T.PageVersion>(`/versions/${id}`),
  pageFiles: (pageId: string) => get<T.PageFile[]>(`/pages/${pageId}/files`),
  backlinks: (pageId: string) => get<T.TreeItemWithSpace[]>(`/pages/${pageId}/backlinks`),
  outgoingLinks: (pageId: string) => get<T.TreeItemWithSpace[]>(`/pages/${pageId}/links`),
  pageExportUrl: (id: string, format: "markdown" | "html", children: boolean, files: boolean) =>
    `/api/pages/${id}/export${qs({ format, children, files })}`,
  pageLabels: (pageId: string) => get<T.Label[]>(`/pages/${pageId}/labels`),
  addLabels: (pageId: string, names: string[]) => post<T.Label[]>(`/pages/${pageId}/labels`, { names }),
  removeLabel: (pageId: string, labelId: string) => post<object>(`/pages/${pageId}/labels/remove`, { labelId }),
  labels: (query?: string) => get<T.LabelWithCount[]>("/labels", { query }),
  labelPages: (id: string) => get<T.TreeItemWithSpace[]>(`/labels/${id}/pages`),
  lookupSynced: (refs: T.SyncedBlockRef[]) => post<T.SyncedBlock[]>("/synced-blocks/lookup", { refs }),

  favorites: () => get<T.Favorites>("/favorites"),
  addFavorite: (ref: { pageId: string } | { spaceId: string }) => post<object>("/favorites", ref),
  removeFavorite: (ref: { pageId: string } | { spaceId: string }) => post<object>("/favorites/remove", ref),
  pageWatch: (id: string) => get<T.WatchState>(`/pages/${id}/watch`),
  setPageWatch: (id: string, watching: boolean) => post<object>(`/pages/${id}/watch`, { watching }),
  spaceWatch: (id: string) => get<T.WatchState>(`/spaces/${id}/watch`),
  setSpaceWatch: (id: string, watching: boolean) => post<object>(`/spaces/${id}/watch`, { watching }),

  comments: (pageId: string) => get<T.Comment[]>(`/pages/${pageId}/comments`),
  createComment: (body: { pageId: string; parentId?: string | null; body: Node; quote?: string | null; anchored?: boolean }) =>
    post<T.CommentResponse>("/comments", body),
  updateComment: (id: string, body: Node) => post<T.CommentResponse>(`/comments/${id}/update`, { body }),
  resolveComment: (id: string, resolved: boolean) => post<T.CommentResponse>(`/comments/${id}/resolve`, { resolved }),
  deleteComment: (id: string) => post<object>(`/comments/${id}/delete`),

  uploadFile: (file: File, pageId: string, replaceId?: string) =>
    request<T.UploadedFile>("POST", "/files", file, { pageId, name: file.name, replaceId }),

  search: (query: { q: string; spaceId?: string; titleOnly?: boolean; limit?: number; offset?: number }) => get<T.SearchResult[]>("/search", query),
  suggest: (query: { q: string; spaceId?: string; users?: boolean; pages?: boolean; limit?: number }) => get<T.Suggestions>("/search/suggest", query),

  pageShare: (pageId: string) => get<T.PageShareState>(`/pages/${pageId}/share`),
  sharePage: (pageId: string, body: { includeChildren?: boolean; searchIndexing?: boolean }) => post<{ share: T.Share }>(`/pages/${pageId}/share`, body),
  unsharePage: (pageId: string) => post<object>(`/pages/${pageId}/share/delete`),
  spaceShares: (spaceId: string) => get<T.ShareWithPage[]>(`/spaces/${spaceId}/shares`),
  publicShare: (key: string) => get<T.PublicShare>(`/public/shares/${key}`),
  publicSharePage: (key: string, page: string) => get<T.PublicSharePage>(`/public/shares/${key}/pages/${encodeURIComponent(page)}`),
  publicShareSearch: (key: string, q: string) => get<T.PublicSearchResult[]>(`/public/shares/${key}/search`, { q }),

  notifications: (query?: { limit?: number; offset?: number; unread?: boolean }) => get<T.Notification[]>("/notifications", query),
  unreadCount: () => get<T.UnreadCount>("/notifications/unread-count"),
  readNotifications: (ids: string[]) => post<object>("/notifications/read", { ids }),
  readAllNotifications: () => post<object>("/notifications/read-all"),

  createBase: (body: { spaceId: string; parentId?: string | null; afterId?: string | null; title?: string; template?: "table" | "kanban" }) =>
    post<{ page: T.TreeItem }>("/bases", body),
  convertToBase: (pageId: string, template: "table" | "kanban") => post<B.Base>(`/pages/${pageId}/convert-to-base`, { template }),
  base: (id: string) => get<B.Base>(`/bases/${encodeURIComponent(id)}`),
  baseRows: (id: string, body: { filter?: B.FilterGroup; sorts?: B.Sort[]; cursor?: string | null; limit?: number }) =>
    post<B.RowsPage>(`/bases/${id}/rows/query`, { ...body, cursor: body.cursor ?? undefined, tzOffset: -new Date().getTimezoneOffset() }),
  baseRow: (id: string, rowId: string) => get<{ row: B.Row; references: B.RowReferences }>(`/bases/${id}/rows/${rowId}`),
  createBaseRow: (id: string, body: { cells?: Record<string, unknown>; afterRowId?: string; position?: string; requestId?: string }) =>
    post<B.Row>(`/bases/${id}/rows`, body),
  updateBaseRow: (id: string, rowId: string, body: { cells?: Record<string, unknown>; position?: string; requestId?: string }) =>
    post<B.Row>(`/bases/${id}/rows/${rowId}/update`, body),
  deleteBaseRows: (id: string, rowIds: string[], requestId?: string) => post<{ rowIds: string[] }>(`/bases/${id}/rows/delete`, { rowIds, requestId }),
  createBaseProperty: (id: string, body: { name: string; type: B.PropertyType; options?: B.PropertyOptions; requestId?: string }) =>
    post<B.Property>(`/bases/${id}/properties`, body),
  updateBaseProperty: (id: string, propertyId: string, body: { name?: string; type?: B.PropertyType; options?: B.PropertyOptions; position?: string; requestId?: string }) =>
    post<B.Property>(`/bases/${id}/properties/${propertyId}/update`, body),
  deleteBaseProperty: (id: string, propertyId: string, requestId?: string) => post<object>(`/bases/${id}/properties/${propertyId}/delete`, { requestId }),
  createBaseView: (id: string, body: { name: string; type: B.ViewType; config?: B.ViewConfig; requestId?: string }) => post<B.View>(`/bases/${id}/views`, body),
  updateBaseView: (id: string, viewId: string, body: { name?: string; config?: Record<string, unknown>; position?: string; requestId?: string }) =>
    post<B.View>(`/bases/${id}/views/${viewId}/update`, body),
  deleteBaseView: (id: string, viewId: string, requestId?: string) => post<object>(`/bases/${id}/views/${viewId}/delete`, { requestId }),
  resolvePages: (pageIds: string[]) => post<{ pages: Record<string, B.ResolvedPage> }>("/bases/resolve-pages", { pageIds }),
  baseCsvUrl: (id: string) => `/api/bases/${id}/export.csv`,
};
