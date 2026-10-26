import type { BaseEvent, Property, Row, View } from "./bases";
import type { Node } from "./editor/model";

export type ApiSuccess<T> = { data: T };
export type ApiFailure = { error: { code: string; message: string } };

export type WorkspaceRole = "owner" | "admin" | "member";
export type SpaceRole = "admin" | "writer" | "reader";

export interface UserPreferences {
  fullPageWidth?: boolean;
  pageEditMode?: "read" | "edit";
  editorToolbar?: boolean;
  theme?: "light" | "dark" | "system";
  notifyPageUpdates?: boolean;
  notifyPageMentions?: boolean;
  notifyCommentMentions?: boolean;
  notifyComments?: boolean;
}

export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: WorkspaceRole;
  locale: string | null;
  timezone: string | null;
  /** Only populated for the current user; empty for others. */
  preferences: UserPreferences;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface Member extends User {
  deactivatedAt: string | null;
}

/** Compact user reference embedded in pages, comments, versions and notifications. */
export interface UserRef {
  id: string;
  name: string;
  avatarUrl: string | null;
}

export interface WorkspaceSettings {
  sharingDisabled?: boolean;
  trashRetentionDays?: number;
  defaultPageEditMode?: "read" | "edit";
}

export interface Workspace {
  name: string;
  description: string | null;
  logoUrl: string | null;
  emailDomains: string[];
  settings: WorkspaceSettings;
  defaultSpaceId: string | null;
  createdAt: string;
}

export interface PublicWorkspace {
  name: string;
  logoUrl: string | null;
}

export interface SetupStatus {
  needsSetup: boolean;
}

export interface SessionInfo {
  id: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

export interface MeResponse {
  user: User;
  workspace: Workspace;
}

export interface UserResponse {
  user: User;
}

export interface WorkspaceResponse {
  workspace: Workspace;
}

export interface Paginated<T> {
  items: T[];
  total: number;
}

export interface Invitation {
  id: string;
  email: string;
  role: "admin" | "member";
  groupIds: string[];
  invitedBy: UserRef | null;
  createdAt: string;
}

export interface CreatedInvitation {
  id: string;
  email: string;
  url: string;
}

export interface InvitationUrl {
  url: string;
}

export interface InvitationInfo {
  email: string;
  workspaceName: string;
}

export interface Group {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  memberCount: number;
}

export interface SpaceSettings {
  sharingDisabled?: boolean;
}

export interface Space {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  iconUrl: string | null;
  settings: SpaceSettings;
  /** The current user's role, or null for workspace admins who are not members. */
  role: SpaceRole | null;
  memberCount: number;
  createdAt: string;
}

export interface SpaceMember {
  id: string;
  role: SpaceRole;
  user?: User;
  group?: Group;
}

export interface TreeItem {
  id: string;
  slugId: string;
  title: string | null;
  icon: string | null;
  parentId: string | null;
  spaceId: string;
  position: string;
  hasChildren: boolean;
  isBase: boolean;
}

/** Minimal space reference attached to tree items in cross-space lists. */
export interface SpaceRef {
  id: string;
  name: string;
  slug: string;
  iconUrl: string | null;
}

export interface TreeItemWithSpace extends TreeItem {
  space: SpaceRef;
}

export interface TrashItem extends TreeItem {
  deletedAt: string;
  deletedBy: UserRef | null;
}

export interface RecentPage extends TreeItemWithSpace {
  updatedAt: string;
  lastEditor: UserRef | null;
}

export interface Page extends TreeItem {
  cover: string | null;
  content: Node | null;
  docVersion: number;
  creator: UserRef | null;
  lastEditor: UserRef | null;
  contributors: UserRef[];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface PageResponse {
  page: Page;
}

export interface PageDetails {
  page: Page;
  space: Space;
  breadcrumbs: TreeItem[];
  canEdit: boolean;
}

export interface PageVersionSummary {
  id: string;
  title: string | null;
  editor: UserRef | null;
  createdAt: string;
}

export interface PageVersion {
  id: string;
  pageId: string;
  title: string | null;
  icon: string | null;
  content: Node | null;
  editor: UserRef | null;
  contributors: UserRef[];
  createdAt: string;
}

export interface Label {
  id: string;
  name: string;
}

export interface LabelWithCount extends Label {
  pageCount: number;
}

export interface SyncedBlockRef {
  pageId: string;
  blockId: string;
}

export interface SyncedBlock extends SyncedBlockRef {
  content: Node[] | null;
}

export interface Favorites {
  pages: TreeItemWithSpace[];
  spaces: Space[];
}

export interface WatchState {
  watching: boolean;
}

export interface Comment {
  id: string;
  pageId: string;
  parentId: string | null;
  author: UserRef | null;
  body: Node;
  quote: string | null;
  anchored: boolean;
  createdAt: string;
  editedAt: string | null;
  resolvedAt: string | null;
  resolvedBy: UserRef | null;
}

export interface CommentResponse {
  comment: Comment;
}

export interface UploadedFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  url: string;
}

export interface PageFile extends UploadedFile {
  uploader: UserRef | null;
  createdAt: string;
}

export interface SearchResult extends TreeItemWithSpace {
  /** Escaped text with `<mark>` around matches. */
  highlight: string;
  updatedAt: string;
}

export interface Suggestions {
  users: User[];
  pages: TreeItemWithSpace[];
}

export interface Share {
  id: string;
  key: string;
  pageId: string;
  includeChildren: boolean;
  searchIndexing: boolean;
  url: string;
  createdAt: string;
}

export interface PageShareState {
  share: Share | null;
  /** The nearest ancestor share that includes this page through `includeChildren`. */
  inheritedFrom: { share: Share; page: TreeItem } | null;
}

export interface ShareWithPage extends Share {
  page: TreeItem;
}

/** A page as seen through a public share: no comment marks, no user details. */
export interface PublicPage extends TreeItem {
  cover: string | null;
  content: Node | null;
  createdAt: string;
  updatedAt: string;
  /** Rows of a shared base, in its first view's order; people and page links are not resolved. */
  base?: { properties: Property[]; view: View | null; rows: Row[]; truncated: boolean };
}

export interface PublicShare {
  share: Share;
  page: PublicPage;
  /** Every page under the shared page (flat, ordered by parent then position) when `includeChildren`. */
  tree?: TreeItem[];
}

export interface PublicSharePage {
  page: PublicPage;
  breadcrumbs: TreeItem[];
}

export interface PublicSearchResult extends TreeItem {
  highlight: string;
  updatedAt: string;
}

export type NotificationKind =
  | "comment.created"
  | "comment.reply"
  | "comment.mention"
  | "page.mention"
  | "page.updated";

export interface NotificationPage {
  id: string;
  slugId: string;
  title: string | null;
  icon: string | null;
  spaceId: string;
  spaceSlug: string;
}

export interface Notification {
  id: string;
  kind: NotificationKind;
  actor: UserRef | null;
  page: NotificationPage | null;
  comment: { id: string; parentId: string | null } | null;
  data: Record<string, unknown>;
  createdAt: string;
  readAt: string | null;
}

export interface UnreadCount {
  count: number;
}

/** Payload of server → client realtime `event` messages. */
export type RealtimeEvent =
  | { kind: "tree"; spaceId: string }
  | { kind: "page"; pageId: string; spaceId: string; title: string | null; icon: string | null }
  | { kind: "comments"; pageId: string }
  | { kind: "notification" }
  | { kind: "base"; pageId: string; spaceId: string; event: BaseEvent; requestId?: string };
