import { Logger } from '@nestjs/common';
import { Automation, BindTrigger } from '@lark-apaas/fullstack-nestjs-core';
import { MeegoBridgeService } from './meego-bridge.service';

/** 妙搭 Webhook 触发器事件（trigger-guide 契约） */
interface TaskHandlerArgs {
  attributes: {
    trigger: string;
    triggerID?: string;
    triggerType: 'record_change' | 'cron' | 'webhook' | 'feishu_approval';
    instanceID: string;
    startAt?: number;
  };
  content: {
    input: string;
  };
}

interface WebhookEvent {
  method: 'GET' | 'POST';
  body: unknown;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Meego 建群 Bridge 自动化任务
 * 触发器：webhook（triggerType=webhook，Meego WorkitemUpdateEvent 报文）
 * 行为：落建群草稿 + 发飞书卡片通知，由人在确认页决定机器人/成员后建群
 */
@Automation()
export class MeegoBridgeAutomationService {
  private readonly logger = new Logger(MeegoBridgeAutomationService.name);

  constructor(private readonly meegoBridgeService: MeegoBridgeService) {}

  @BindTrigger('meegoWebhookTrigger')
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
      this.logger.error('JSON 解析失败', error instanceof Error ? error.stack : String(error));
      return;
    }

    // body 是 Meego WorkitemUpdateEvent 报文：{ header, payload }
    if (!isJsonObject(webhookEvent.body)) {
      this.logger.error(`Webhook body 不符合业务 schema：${typeof webhookEvent.body}`);
      return;
    }
    const payload = isJsonObject(webhookEvent.body.payload)
      ? webhookEvent.body.payload
      : null;
    if (!payload || payload.id === undefined || payload.id === null) {
      this.logger.error('Meego 报文缺少 payload.id（工作项 id）');
      return;
    }

    const draft = await this.meegoBridgeService.handleWorkItemEvent(payload);
    this.logger.log(
      `Meego 事件已落草稿：work_item=${draft.workItemId} mode=${draft.mode} pending=${draft.id}`,
    );
  }
}
