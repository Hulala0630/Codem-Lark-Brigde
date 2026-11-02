/* 前后端共享的类型写在这里 */

export const PENDING_MODES = ['create', 'update'] as const;
export type PendingMode = (typeof PENDING_MODES)[number];
export const isPendingMode = (v: string): v is PendingMode =>
  (PENDING_MODES as readonly string[]).includes(v);

export const PENDING_STATUSES = ['pending', 'confirmed'] as const;
export type PendingStatus = (typeof PENDING_STATUSES)[number];

/** Meego 工作项事件生成的建群草稿（确认页展示） */
export interface MeegoPendingDraft {
  id: string;
  workItemId: string;
  workItemType: string | null;
  workItemName: string | null;
  project: string | null;
  mode: PendingMode;
  groupName: string | null;
  description: string | null;
  changedText: string | null;
  existingChatId: string | null;
  status: PendingStatus;
  createdAt: string;
}

/** 确认建群/更新群请求 */
export interface ConfirmGroupRequest {
  pendingId: string;
  /** 要拉进群的机器人 app_id 列表（cli_ 开头）；空数组 = 不拉任何机器人 */
  bots: string[];
  /** 是否把配置的确认人（owner open_id）拉进群 */
  includeMe: boolean;
  /** 额外成员 open_id 列表（ou_ 开头） */
  members?: string[];
}

/** 确认建群/更新群结果 */
export interface ConfirmGroupResult {
  mode: PendingMode;
  chatId: string;
  chatName: string;
  chatLink: string;
  usersAdded: number;
  botsAdded: number;
  alreadyInChat: string[];
  changedMessageSent: boolean;
  unresolvedMembers: string[];
}
