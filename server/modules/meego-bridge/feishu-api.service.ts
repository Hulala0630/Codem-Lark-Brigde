import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

/** 飞书 OpenAPI 响应外壳 */
interface FeishuEnvelope<T> {
  code: number;
  msg: string;
  data: T;
}

/** tenant_access_token 接口响应：token 在顶层，不在 data 里 */
interface TenantTokenResponse {
  code: number;
  msg: string;
  tenant_access_token?: string;
  expire?: number;
}

interface CreateChatData {
  chat_id: string;
  name?: string;
}

interface AddMembersData {
  invalid_id_list: string[];
  not_existed_id_list: string[];
}

interface ChatMembersData {
  items: Array<{
    member_id: string;
    member_id_type: string;
    name?: string;
  }>;
  has_more: boolean;
  page_token?: string;
}

interface SendMessageData {
  message_id: string;
}

/**
 * 飞书 OpenAPI 客户端：用自建应用凭证（tenant_access_token）
 * 直连 open.feishu.cn，提供建群 / 拉成员（含机器人）/ 发消息能力。
 */
@Injectable()
export class FeishuApiService {
  private readonly logger = new Logger(FeishuApiService.name);
  private tokenCache: { token: string; expireAt: number } | null = null;

  constructor(private readonly http: HttpService) {}

  private getAppConfig(): { appId: string; appSecret: string } {
    const appId = process.env.FEISHU_APP_ID || '';
    const appSecret = process.env.FEISHU_APP_SECRET || '';
    if (!appId || !appSecret) {
      throw new Error(
        '缺少飞书应用凭证：请配置环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET（自建应用的 app_id 与 app_secret）',
      );
    }
    return { appId, appSecret };
  }

  /** 获取（并缓存）tenant_access_token */
  async getTenantToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expireAt > now + 60_000) {
      return this.tokenCache.token;
    }
    const { appId, appSecret } = this.getAppConfig();
    const res = await firstValueFrom(
      this.http.post<TenantTokenResponse>(
        'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        { app_id: appId, app_secret: appSecret },
        { headers: { 'Content-Type': 'application/json; charset=utf-8' } },
      ),
    );
    const body = res.data;
    if (body.code !== 0 || !body.tenant_access_token) {
      throw new Error(`获取 tenant_access_token 失败：${body.code} ${body.msg}`);
    }
    this.tokenCache = {
      token: body.tenant_access_token,
      expireAt: now + (body.expire ?? 3600) * 1000,
    };
    return this.tokenCache.token;
  }

  private async request<T>(
    method: 'get' | 'post',
    url: string,
    data?: unknown,
  ): Promise<T> {
    const token = await this.getTenantToken();
    const res = await firstValueFrom(
      method === 'get'
        ? this.http.get<FeishuEnvelope<T>>(url, {
            headers: { Authorization: `Bearer ${token}` },
          })
        : this.http.post<FeishuEnvelope<T>>(url, data, {
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json; charset=utf-8',
            },
          }),
    );
    const body = res.data;
    if (body.code !== 0) {
      throw new Error(`飞书 API 调用失败 ${url}：${body.code} ${body.msg}`);
    }
    return body.data;
  }

  /** 创建群聊（应用机器人为群主），返回 chat_id */
  async createChat(name: string, description?: string): Promise<string> {
    const data = await this.request<CreateChatData>(
      'post',
      'https://open.feishu.cn/open-apis/im/v1/chats?user_id_type=open_id',
      { name, description, chat_mode: 'group' },
    );
    return data.chat_id;
  }

  /**
   * 拉用户或机器人进群。memberIdType: open_id（用户）/ app_id（机器人）。
   * 返回无效 ID 列表。
   */
  async addChatMembers(
    chatId: string,
    idList: string[],
    memberIdType: 'open_id' | 'app_id',
  ): Promise<string[]> {
    if (!idList.length) return [];
    const data = await this.request<AddMembersData>(
      'post',
      `https://open.feishu.cn/open-apis/im/v1/chats/${chatId}/members?member_id_type=${memberIdType}&succeed_type=1`,
      { id_list: idList },
    );
    return [...(data.invalid_id_list || []), ...(data.not_existed_id_list || [])];
  }

  /** 获取群成员与机器人（member_id：用户 ou_ / 机器人按 app_id 单独查询） */
  async getChatMembers(chatId: string): Promise<{
    users: string[];
    bots: string[];
  }> {
    const users: string[] = [];
    const bots: string[] = [];
    let pageToken = '';
    // 群规模上限 5000，此处只为判断“谁已在群内”，翻 10 页（每页 100）足够本场景
    for (let i = 0; i < 10; i++) {
      const url = `https://open.feishu.cn/open-apis/im/v1/chats/${chatId}/members?page_size=100${
        pageToken ? `&page_token=${pageToken}` : ''
      }`;
      const data = await this.request<ChatMembersData>('get', url);
      for (const item of data.items || []) {
        if (item.member_id_type === 'app_id' || /^cli_/.test(item.member_id)) {
          bots.push(item.member_id);
        } else {
          users.push(item.member_id);
        }
      }
      if (!data.has_more || !data.page_token) break;
      pageToken = data.page_token;
    }
    return { users, bots };
  }

  /** 发送消息。receiveIdType: chat_id / open_id；msgType: text / interactive */
  async sendMessage(
    receiveIdType: 'chat_id' | 'open_id',
    receiveId: string,
    msgType: 'text' | 'interactive',
    content: unknown,
  ): Promise<string> {
    const data = await this.request<SendMessageData>(
      'post',
      `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`,
      { receive_id: receiveId, msg_type: msgType, content: JSON.stringify(content) },
    );
    return data.message_id;
  }

  /** 发送文本消息到群 */
  async sendTextToChat(chatId: string, text: string): Promise<string> {
    return this.sendMessage('chat_id', chatId, 'text', { text });
  }

  /** 发送文本消息给个人（汇总通知负责人用） */
  async sendTextToUser(openId: string, text: string): Promise<string> {
    return this.sendMessage('open_id', openId, 'text', { text });
  }

  /** 发送交互卡片（新建模式：发给确认人私聊） */
  async sendCardToUser(ownerOpenId: string, card: unknown): Promise<string> {
    return this.sendMessage('open_id', ownerOpenId, 'interactive', card);
  }

  /** 发送交互卡片到群（更新模式） */
  async sendCardToChat(chatId: string, card: unknown): Promise<string> {
    return this.sendMessage('chat_id', chatId, 'interactive', card);
  }
}
