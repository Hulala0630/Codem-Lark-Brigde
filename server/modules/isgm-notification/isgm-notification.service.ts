import { Injectable, Inject, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, eq } from 'drizzle-orm';
import { riskFeedback, workitemGroupMap } from '@server/database/schema';
import { FeishuApiService } from '../meego-bridge/feishu-api.service';
import type { RiskItem, WeeklyReportInput } from './risk-parser.service';

/** 固定负责人（周报接收人）：汇总消息发送目标 */
const REPORT_OWNER_OPEN_ID =
  process.env.ISGM_REPORT_OWNER_OPEN_ID ||
  process.env.BRIDGE_OWNER_OPEN_ID ||
  'ou_65293baac0acd0ca02ccf7bcbd4a24b8';
/** 拉进跟进群的机器人（可逗号分隔多个 app_id） */
const ISGM_BOT_APP_IDS = (process.env.ISGM_BOT_APP_IDS || 'cli_aac5d4db58385cd3')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export interface CycleStatus {
  cycleKey: string;
  chatId: string | null;
  total: number;
  responded: number;
  pending: number;
  overdue: number;
  allResponded: boolean;
  items: Array<{
    desc: string;
    ownerOpenId: string;
    ownerName: string | null;
    status: string;
    feedback: string | null;
    deadline: string | null;
  }>;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * IS4GM 周报风险闭环（场景一）
 * 周报进入 → 解析风险项与责任人 → 建群/复用群 @责任人收集完成计划
 * → 全员反馈完成（或强制）→ 汇总通知固定负责人并同步群内。
 * 群映射复用 workitem_group_map，映射键为 isgm_risk:{cycleKey}，只增不重建。
 */
@Injectable()
export class IsgmNotificationService {
  private readonly logger = new Logger(IsgmNotificationService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly feishuApi: FeishuApiService,
  ) {}

  private mappingKey(cycleKey: string): string {
    return `isgm_risk:${cycleKey}`;
  }

  private riskHash(cycleKey: string, desc: string, owner: string): string {
    return createHash('sha1').update(`${cycleKey}|${desc}|${owner}`).digest('hex').slice(0, 40);
  }

  /** 处理一期周报：落风险表 → 建群/复用群 → 群内 @ 各责任人收集反馈 */
  async handleWeeklyReport(input: WeeklyReportInput): Promise<CycleStatus> {
    const { cycleKey, risks } = input;

    // 落风险反馈行（周期+风险+责任人 唯一，重发幂等）
    for (const r of risks) {
      if (!r.ownerOpenId) {
        // 姓名暂无法自动解析为 open_id，落行为 pending 并在消息中提示
        this.logger.warn(`风险「${r.desc}」缺少 ownerOpenId（ownerName=${r.ownerName ?? '无'}），请补 open_id`);
      }
      const owner = r.ownerOpenId || 'unknown';
      const hash = this.riskHash(cycleKey, r.desc, owner);
      await this.db
        .insert(riskFeedback)
        .values({
          cycleKey,
          riskHash: hash,
          riskDesc: r.desc,
          ownerOpenId: owner,
          ownerName: r.ownerName ?? null,
          status: 'pending',
          deadline: r.deadline ? new Date(r.deadline) : null,
        })
        .onConflictDoUpdate({
          target: [riskFeedback.cycleKey, riskFeedback.riskHash],
          set: { riskDesc: r.desc, ownerName: r.ownerName ?? null },
        });
    }

    const chatId = await this.ensureGroup(cycleKey, input.title);
    await this.pushRiskNotice(cycleKey, chatId);
    return this.getStatus(cycleKey);
  }

  /** 建群或复用已有群（映射键 isgm_risk:{cycleKey}） */
  private async ensureGroup(cycleKey: string, title?: string): Promise<string> {
    const mappingKey = this.mappingKey(cycleKey);
    const existing = await this.db
      .select()
      .from(workitemGroupMap)
      .where(eq(workitemGroupMap.workItemId, mappingKey))
      .limit(1);

    if (existing[0]) return existing[0].chatId;

    const chatName = `IS4GM 风险跟进 ${cycleKey}`.slice(0, 60);
    const description = (title ? `${title}。` : '') + '周报风险责任人反馈收集群，由 IS4GM 闭环自动创建';
    const chatId = await this.feishuApi.createChat(chatName, description.slice(0, 200));

    // 拉固定负责人 + 机器人；责任人在群内消息 @ 时拉起（未入群时 @ 不可达，先拉所有已知 owner）
    const owners = await this.db
      .select({ ownerOpenId: riskFeedback.ownerOpenId })
      .from(riskFeedback)
      .where(eq(riskFeedback.cycleKey, cycleKey));
    const memberIds = [...new Set([REPORT_OWNER_OPEN_ID, ...owners.map((o) => o.ownerOpenId)])]
      .filter((id) => /^ou_/.test(id));
    try {
      await this.feishuApi.addChatMembers(chatId, memberIds, 'open_id');
    } catch (error) {
      this.logger.warn('拉成员进群部分失败（可在群内手动添加责任人）', String(error));
    }
    for (const botId of ISGM_BOT_APP_IDS) {
      try {
        await this.feishuApi.addChatMembers(chatId, [botId], 'app_id');
      } catch (error) {
        this.logger.warn(`拉机器人 ${botId} 进群失败`, String(error));
      }
    }

    await this.db
      .insert(workitemGroupMap)
      .values({ workItemId: mappingKey, chatId, chatName })
      .onConflictDoUpdate({
        target: workitemGroupMap.workItemId,
        set: { chatId, chatName },
      });
    return chatId;
  }

  /** 群内推送风险清单并 @ 各责任人（文本消息支持 <at> 标签） */
  private async pushRiskNotice(cycleKey: string, chatId: string): Promise<void> {
    const rows = await this.db
      .select()
      .from(riskFeedback)
      .where(eq(riskFeedback.cycleKey, cycleKey));
    const lines = rows.map((row) => {
      const at = /^ou_/.test(row.ownerOpenId)
        ? `<at user_id="${row.ownerOpenId}"></at>`
        : `（待补 open_id：${row.ownerName ?? '未知责任人'}）`;
      const deadline = row.deadline ? `，截止 ${row.deadline.toISOString().slice(0, 10)}` : '';
      return `- ${row.riskDesc} → ${at} 请回复完成计划${deadline}`;
    });
    const text = `【IS4GM 周报风险收集】周期 ${cycleKey}\n以下责任人请在群内回复各自风险项的完成计划：\n${lines.join('\n')}`;
    await this.feishuApi.sendTextToChat(chatId, text);
  }

  /** 记录某责任人的反馈（状态 pending → responded） */
  async recordFeedback(input: {
    cycleKey: string;
    ownerOpenId?: string;
    ownerName?: string;
    feedback: string;
  }): Promise<CycleStatus> {
    const { cycleKey, feedback } = input;
    const owner = input.ownerOpenId || input.ownerName;
    if (!owner) throw new Error('缺少 ownerOpenId 或 ownerName');

    const condition = /^ou_/.test(owner)
      ? and(eq(riskFeedback.cycleKey, cycleKey), eq(riskFeedback.ownerOpenId, owner))
      : and(eq(riskFeedback.cycleKey, cycleKey), eq(riskFeedback.ownerName, owner));
    const updated = await this.db
      .update(riskFeedback)
      .set({ status: 'responded', feedback })
      .where(condition)
      .returning();
    if (!updated.length) {
      throw new Error(`周期 ${cycleKey} 未找到责任人 ${owner} 的待反馈风险项`);
    }

    const status = await this.getStatus(cycleKey);
    // 全员反馈完成 → 自动汇总
    if (status.allResponded) {
      await this.summarize(cycleKey, false);
    }
    return status;
  }

  /** 汇总：发送给固定负责人 + 同步群内；未全员完成时须 force */
  async summarize(cycleKey: string, force: boolean): Promise<{ sent: boolean; reason?: string }> {
    const status = await this.getStatus(cycleKey);
    if (!status.allResponded && !force) {
      return { sent: false, reason: `还有 ${status.pending + status.overdue} 项未反馈，未汇总（可 force）` };
    }
    const lines = status.items.map((it) => {
      const mark = it.status === 'responded' ? '✅' : it.status === 'overdue' ? '⏰' : '⬜';
      const feedback = it.feedback ? `：${it.feedback}` : '：（未反馈）';
      return `${mark} ${it.desc}（${it.ownerName ?? it.ownerOpenId}${feedback}）`;
    });
    const text = `【IS4GM 周报风险汇总】周期 ${cycleKey}\n共 ${status.total} 项，已反馈 ${status.responded} 项\n${lines.join('\n')}`;

    await this.feishuApi.sendTextToUser(REPORT_OWNER_OPEN_ID, text);
    if (status.chatId) {
      try {
        await this.feishuApi.sendTextToChat(status.chatId, text);
      } catch (error) {
        this.logger.warn('汇总同步群内失败', String(error));
      }
    }
    return { sent: true };
  }

  /** 周期状态查询 */
  async getStatus(cycleKey: string): Promise<CycleStatus> {
    const mapping = await this.db
      .select()
      .from(workitemGroupMap)
      .where(eq(workitemGroupMap.workItemId, this.mappingKey(cycleKey)))
      .limit(1);
    const rows = await this.db
      .select()
      .from(riskFeedback)
      .where(eq(riskFeedback.cycleKey, cycleKey));
    const items = rows.map((row) => ({
      desc: row.riskDesc,
      ownerOpenId: row.ownerOpenId,
      ownerName: row.ownerName,
      status: row.status,
      feedback: row.feedback,
      deadline: row.deadline ? row.deadline.toISOString().slice(0, 10) : null,
    }));
    const responded = rows.filter((r) => r.status === 'responded').length;
    const overdue = rows.filter((r) => r.status === 'overdue').length;
    return {
      cycleKey,
      chatId: mapping[0]?.chatId ?? null,
      total: rows.length,
      responded,
      pending: rows.length - responded - overdue,
      overdue,
      allResponded: rows.length > 0 && responded === rows.length,
      items,
    };
  }
}

export function parseAutomationBody(body: unknown): Record<string, unknown> | null {
  return isJsonObject(body) ? body : null;
}
