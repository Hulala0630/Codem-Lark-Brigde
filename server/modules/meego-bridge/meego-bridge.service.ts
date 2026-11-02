import { Injectable, Inject, Logger } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { eq } from 'drizzle-orm';
import { meegoPending, workitemGroupMap } from '@server/database/schema';
import { FeishuApiService } from './feishu-api.service';
import type {
  ConfirmGroupResult,
  MeegoPendingDraft,
  PendingMode,
  PendingStatus,
} from '@shared/api.interface';

/** Meego WorkitemUpdateEvent.payload 的最小业务结构（宽松结构，字段安全读取） */
type MeegoPayloadLike = Record<string, unknown>;

type ChangedFieldLike = Record<string, unknown>;

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pickStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** 配置：默认值可用环境变量覆盖 */
const BRIDGE_OWNER_OPEN_ID =
  process.env.BRIDGE_OWNER_OPEN_ID || 'ou_65293baac0acd0ca02ccf7bcbd4a24b8';
const CODEM_BOT_APP_ID =
  process.env.CODEM_BOT_APP_ID || 'cli_aac5d4db58385cd3';
const APP_BASE_URL =
  process.env.BRIDGE_APP_BASE_URL ||
  `https://miaoda.feishu.cn/app/${process.env.MIAODA_APP_ID || 'app_17h8p67zq7s'}`;

function toDraft(row: typeof meegoPending.$inferSelect): MeegoPendingDraft {
  return {
    id: row.id,
    workItemId: row.workItemId,
    workItemType: row.workItemType,
    workItemName: row.workItemName,
    project: row.project,
    mode: row.mode as PendingMode,
    groupName: row.groupName,
    description: row.description,
    changedText: row.changedText,
    existingChatId: row.existingChatId,
    status: row.status as PendingStatus,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class MeegoBridgeService {
  private readonly logger = new Logger(MeegoBridgeService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly feishuApi: FeishuApiService,
  ) {}

  /** Meego 变更字段 → 变更说明文本（群内首条消息同源） */
  private formatChangedFields(fields: ChangedFieldLike[], wi: {
    id: string;
    name: string;
    type: string;
  }): string {
    const lines: string[] = [];
    for (const f of fields) {
      const alias = pickStr(f.field_alias);
      const key = pickStr(f.field_key);
      const label = alias || key || 'field';
      const pick = (v: unknown, md: unknown): string => {
        if (isJsonObject(md) && typeof md.markdown === 'string') return md.markdown;
        if (v === null || v === undefined || v === '') return '(空)';
        if (typeof v === 'string') return v;
        return JSON.stringify(v);
      };
      const pre = pick(f.pre_field_value, f.pre_field_value_markdown);
      const cur = pick(f.cur_field_value, f.cur_field_value_markdown);
      const cut = (s: string): string => (s.length > 120 ? `${s.slice(0, 117)}...` : s);
      lines.push(`- ${label}：${cut(pre)} → ${cut(cur)}`);
    }
    const head = `【Meego 工作项变更】${wi.type}#${wi.id}「${wi.name}」`;
    return lines.length ? `${head}\n${lines.join('\n')}` : head;
  }

  /** 处理 Meego WorkitemUpdateEvent：落草稿 + 发飞书卡片通知 */
  async handleWorkItemEvent(payload: MeegoPayloadLike): Promise<MeegoPendingDraft> {
    const workItemId = String(payload.id ?? '');
    if (!workItemId) throw new Error('payload.id（工作项 id）缺失');

    const wiName = pickStr(payload.name).trim();
    const type = pickStr(payload.work_item_type_key) || 'workitem';
    const project = pickStr(payload.project_simple_name) || pickStr(payload.project_key);
    const changedFieldsRaw = payload.changed_fields;
    const changedFields: ChangedFieldLike[] = Array.isArray(changedFieldsRaw)
      ? changedFieldsRaw.filter((f: unknown): f is Record<string, unknown> => isJsonObject(f))
      : [];
    const groupName = wiName
      ? `${type}#${workItemId} ${wiName}`.slice(0, 60)
      : `${type}#${workItemId}`.slice(0, 60);
    const description = `Meego 工作项：${type} #${workItemId}${wiName ? `「${wiName}」` : ''}${
      project ? `（空间：${project}）` : ''
    }。由 webhook 自动创建`.slice(0, 200);

    // 查映射：已有群则进入更新模式
    const existing = await this.db
      .select()
      .from(workitemGroupMap)
      .where(eq(workitemGroupMap.workItemId, workItemId))
      .limit(1);
    const existingChat = existing[0] ?? null;
    const mode: PendingMode = existingChat ? 'update' : 'create';

    const changedText = this.formatChangedFields(
      changedFields,
      { id: workItemId, name: wiName, type },
    );

    // 落草稿
    const inserted = await this.db
      .insert(meegoPending)
      .values({
        workItemId,
        workItemType: type,
        workItemName: wiName || null,
        project: project || null,
        mode,
        groupName,
        description,
        changedText,
        existingChatId: existingChat?.chatId ?? null,
        status: 'pending',
      })
      .returning();
    const draft = toDraft(inserted[0]);

    // 发飞书卡片（失败不阻断草稿，只记日志）
    try {
      const card = this.buildEventCard(draft, existingChat?.chatName);
      if (mode === 'update' && existingChat) {
        await this.feishuApi.sendCardToChat(existingChat.chatId, card);
      } else {
        await this.feishuApi.sendCardToUser(BRIDGE_OWNER_OPEN_ID, card);
      }
    } catch (error) {
      this.logger.error(
        `卡片发送失败（草稿 ${draft.id} 不受影响，可在应用内确认）`,
        error instanceof Error ? error.stack : String(error),
      );
    }
    return draft;
  }

  /** 构造通知卡片：内容=变更字段；按钮=打开确认页（CodeM 默认勾选） */
  private buildEventCard(
    draft: MeegoPendingDraft,
    existingChatName?: string | null,
  ): Record<string, unknown> {
    const isUpdate = draft.mode === 'update';
    const title = isUpdate
      ? `【Meego 工作项变更·群已存在】${draft.workItemType}#${draft.workItemId}「${draft.workItemName ?? ''}」`
      : `【Meego 工作项变更】${draft.workItemType}#${draft.workItemId}「${draft.workItemName ?? ''}」`;
    const lines = (draft.changedText || '').split('\n').filter(Boolean);
    const md = lines.slice(1).join('\n') || '（无字段变更信息）';
    const reviewUrl = `${APP_BASE_URL}/review/${draft.id}`;
    return {
      config: { wide_screen_mode: true },
      header: {
        template: isUpdate ? 'turquoise' : 'blue',
        title: { tag: 'plain_text', content: title.slice(0, 100) },
      },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: md } },
        { tag: 'hr' },
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: isUpdate
              ? `该工作项已有群「${existingChatName || ''}」，打开确认页可将新勾选的机器人/成员拉入已有群，变更信息也会发送到群内，不会新建群。`
              : '打开确认页一键建群：**默认勾选拉入飞书 CodeM 机器人**，可自行取消或填写其他机器人 app_id。',
          },
        },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: {
                tag: 'plain_text',
                content: isUpdate ? '打开确认页（更新群）' : '打开确认页（建群）',
              },
              type: 'primary',
              url: `${reviewUrl}?bots=codem`,
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '不含 CodeM' },
              type: 'default',
              url: `${reviewUrl}?bots=none`,
            },
          ],
        },
        { tag: 'note', elements: [{ tag: 'plain_text', content: '由 Meego 建群 Bridge 自动发送' }] },
      ],
    };
  }

  /** 确认页读取草稿 */
  async getPending(pendingId: string): Promise<MeegoPendingDraft> {
    const rows = await this.db
      .select()
      .from(meegoPending)
      .where(eq(meegoPending.id, pendingId))
      .limit(1);
    if (!rows[0]) throw new Error('草稿不存在或已过期');
    return toDraft(rows[0]);
  }

  /**
   * 确认执行：建群或更新群。
   * - create：建群（应用机器人为群主）→ 拉确认人/成员/机器人 → 变更字段作为首条消息 → 存映射
   * - update：过滤已在外成员/机器人后拉新 → 变更信息发到群内
   */
  async confirmPending(input: {
    pendingId: string;
    bots: string[];
    includeMe: boolean;
    members?: string[];
  }): Promise<ConfirmGroupResult> {
    const draft = await this.getPending(input.pendingId);
    if (draft.status !== 'pending') {
      throw new Error(`草稿已处理（status=${draft.status}），请勿重复确认`);
    }

    // 机器人：只接受 cli_ 开头的 app_id
    const bots = [...new Set(input.bots.map((b) => b.trim()).filter((b) => /^cli_[0-9a-z]+$/i.test(b)))].slice(0, 5);
    // 成员：只接受 ou_ 开头的 open_id，其余进入 unresolved
    const memberIds = (input.members || []).map((m) => m.trim()).filter(Boolean);
    const validMembers = memberIds.filter((m) => /^ou_[0-9a-f]{16,}$/i.test(m));
    const unresolvedMembers = memberIds.filter((m) => !/^ou_[0-9a-f]{16,}$/i.test(m));
    const users = new Set<string>(validMembers);
    if (input.includeMe) users.add(BRIDGE_OWNER_OPEN_ID);

    let chatId: string;
    let chatName: string;
    let usersAdded = 0;
    let botsAdded = 0;
    const alreadyInChat: string[] = [];

    if (draft.mode === 'update' && draft.existingChatId) {
      chatId = draft.existingChatId;
      chatName = draft.groupName || '';
      // 查现有成员，过滤已在群的
      const current = await this.feishuApi.getChatMembers(chatId);
      const currentUserSet = new Set(current.users);
      const currentBotSet = new Set(current.bots);
      const newUsers = [...users].filter((u) => !currentUserSet.has(u));
      const newBots = bots.filter((b) => !currentBotSet.has(b));
      for (const u of [...users]) if (currentUserSet.has(u)) alreadyInChat.push(u);
      for (const b of bots) if (currentBotSet.has(b)) alreadyInChat.push(b);

      const invalidUsers = await this.feishuApi.addChatMembers(chatId, newUsers, 'open_id');
      const invalidBots = await this.feishuApi.addChatMembers(chatId, newBots, 'app_id');
      usersAdded = newUsers.length - invalidUsers.length;
      botsAdded = newBots.length - invalidBots.length;
      for (const id of [...invalidUsers, ...invalidBots]) unresolvedMembers.push(id);
    } else {
      chatName = draft.groupName || `meego#${draft.workItemId}`;
      chatId = await this.feishuApi.createChat(chatName, draft.description || undefined);
      const invalidUsers = await this.feishuApi.addChatMembers(chatId, [...users], 'open_id');
      const invalidBots = await this.feishuApi.addChatMembers(chatId, bots, 'app_id');
      usersAdded = users.size - invalidUsers.length;
      botsAdded = bots.length - invalidBots.length;
      for (const id of [...invalidUsers, ...invalidBots]) unresolvedMembers.push(id);

      // 工作项 → 群映射落库（幂等 upsert）
      await this.db
        .insert(workitemGroupMap)
        .values({
          workItemId: draft.workItemId,
          chatId,
          chatName,
        })
        .onConflictDoUpdate({
          target: workitemGroupMap.workItemId,
          set: { chatId, chatName },
        });
    }

    // 变更字段作为群内消息
    let changedMessageSent = false;
    try {
      await this.feishuApi.sendTextToChat(chatId, draft.changedText || '');
      changedMessageSent = true;
    } catch (error) {
      this.logger.error(
        `变更消息发送失败（chat ${chatId}）`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    // 草稿置为已处理
    await this.db
      .update(meegoPending)
      .set({ status: 'confirmed' })
      .where(eq(meegoPending.id, draft.id));

    return {
      mode: draft.mode,
      chatId,
      chatName,
      chatLink: `https://applink.feishu.cn/client/chat/open?openChatId=${chatId}`,
      usersAdded,
      botsAdded,
      alreadyInChat,
      changedMessageSent,
      unresolvedMembers,
    };
  }
}
