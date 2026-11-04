import { Logger } from '@nestjs/common';
import { Automation, BindTrigger } from '@lark-apaas/fullstack-nestjs-core';
import { IsgmNotificationService } from './isgm-notification.service';
import { RiskParserService } from './risk-parser.service';

interface TaskHandlerArgs {
  attributes: { trigger: string; triggerType: string; instanceID: string };
  content: { input: string };
}

interface WebhookEvent {
  method: 'GET' | 'POST';
  body: unknown;
}

/**
 * IS4GM 周报风险闭环自动化入口（新妙搭应用 isgmRiskTrigger）
 * Webhook body: { action: 'report' | 'feedback' | 'summarize', ...payload }
 * - report（默认）：周报报文（结构化 risks / 文本 text），触发解析建群 @ 收集
 * - feedback：责任人反馈 { cycleKey, ownerOpenId|ownerName, feedback }
 * - summarize：汇总 { cycleKey, force? }
 */
@Automation()
export class IsgmNotificationAutomationService {
  private readonly logger = new Logger(IsgmNotificationAutomationService.name);

  constructor(
    private readonly isgmService: IsgmNotificationService,
    private readonly riskParser: RiskParserService,
  ) {}

  @BindTrigger('isgmRiskTrigger')
  async handleWebhook(event: TaskHandlerArgs): Promise<void> {
    const input = event.content.input;
    if (typeof input !== 'string') {
      this.logger.error('input 类型错误');
      return;
    }
    let webhookEvent: WebhookEvent;
    try {
      webhookEvent = JSON.parse(input) as WebhookEvent;
    } catch (error) {
      this.logger.error('JSON 解析失败', String(error));
      return;
    }
    const body = webhookEvent.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      this.logger.error('Webhook body 不是 JSON 对象');
      return;
    }
    const payload = body as Record<string, unknown>;
    const action = typeof payload.action === 'string' ? payload.action : 'report';
    const data = (payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data))
      ? payload.data as Record<string, unknown>
      : payload;

    try {
      if (action === 'feedback') {
        const cycleKey = String(data.cycleKey ?? data.cycle_key ?? '');
        const ownerOpenId = typeof data.ownerOpenId === 'string' ? data.ownerOpenId : undefined;
        const ownerName = typeof data.ownerName === 'string' ? data.ownerName : undefined;
        const feedback = String(data.feedback ?? '');
        if (!cycleKey || !(ownerOpenId || ownerName) || !feedback) {
          throw new Error('feedback 需要 cycleKey、ownerOpenId/ownerName、feedback');
        }
        const status = await this.isgmService.recordFeedback({ cycleKey, ownerOpenId, ownerName, feedback });
        this.logger.log(`反馈已记录：cycle=${cycleKey} responded=${status.responded}/${status.total}`);
      } else if (action === 'summarize') {
        const cycleKey = String(data.cycleKey ?? data.cycle_key ?? '');
        const force = data.force === true || data.force === 'true';
        if (!cycleKey) throw new Error('summarize 需要 cycleKey');
        const result = await this.isgmService.summarize(cycleKey, force);
        this.logger.log(`汇总结果：cycle=${cycleKey} sent=${result.sent} ${result.reason ?? ''}`);
      } else {
        const report = this.riskParser.parse(data);
        const status = await this.isgmService.handleWeeklyReport(report);
        this.logger.log(`周报已处理：cycle=${report.cycleKey} risks=${status.total} chat=${status.chatId}`);
      }
    } catch (error) {
      this.logger.error(`处理 action=${action} 失败`, error instanceof Error ? error.stack : String(error));
      throw error;
    }
  }
}
