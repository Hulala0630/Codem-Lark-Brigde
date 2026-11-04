import { Injectable, Logger } from '@nestjs/common';

/** 周报风险项（解析产物） */
export interface RiskItem {
  desc: string;
  ownerName?: string;
  ownerOpenId?: string;
  deadline?: string;
}

/** 周报输入（结构化或文本两种形态） */
export interface WeeklyReportInput {
  cycleKey: string;
  title?: string;
  risks: RiskItem[];
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pickStr(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * 周报风险解析器（场景一适配件①）
 * 优先接受结构化 JSON（risks 数组）；也支持简单文本行格式：
 *   风险描述 | 责任人姓名 | 截止时间（后两项可省略）
 * 周报格式稳定后可替换为 AI 提取，输出结构不变。
 */
@Injectable()
export class RiskParserService {
  private readonly logger = new Logger(RiskParserService.name);

  parse(body: unknown): WeeklyReportInput {
    if (!isJsonObject(body)) {
      throw new Error('周报报文必须是 JSON 对象');
    }
    const cycleKey = pickStr(body.cycle_key, body.cycleKey, body.cycle);
    if (!cycleKey) {
      throw new Error('缺少周期标识（cycle_key / cycleKey），如 2026-W45');
    }

    // 形态一：结构化 risks 数组
    if (Array.isArray(body.risks)) {
      const risks: RiskItem[] = [];
      for (const raw of body.risks) {
        if (!isJsonObject(raw)) continue;
        const desc = pickStr(raw.desc, raw.description, raw.risk);
        if (!desc) continue;
        risks.push({
          desc,
          ownerName: pickStr(raw.owner_name, raw.ownerName, raw.owner),
          ownerOpenId: pickStr(raw.owner_open_id, raw.ownerOpenId),
          deadline: pickStr(raw.deadline, raw.due),
        });
      }
      if (!risks.length) throw new Error('risks 数组中没有有效风险项（需含 desc 字段）');
      return { cycleKey, title: pickStr(body.title), risks };
    }

    // 形态二：纯文本行格式（每行：desc | owner | deadline）
    const text = pickStr(body.text, body.content);
    if (text) {
      const risks: RiskItem[] = [];
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const [desc, owner, deadline] = trimmed.split('|').map((s) => s.trim());
        if (desc) risks.push({ desc, ownerName: owner, deadline });
      }
      if (!risks.length) throw new Error('text 中未解析到风险行（格式：风险描述 | 责任人 | 截止时间）');
      return { cycleKey, title: pickStr(body.title), risks };
    }

    throw new Error('报文需包含 risks 数组或 text 文本');
  }
}
