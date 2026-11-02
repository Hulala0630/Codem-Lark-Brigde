import { useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { logger } from '@lark-apaas/client-toolkit/logger';
import { meegoBridge } from '@/api';
import type { ConfirmGroupResult } from '@shared/api.interface';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';

const CODEM_BOT_APP_ID = 'cli_aac5d4db58385cd3';

interface BotRow {
  key: number;
  appId: string;
  checked: boolean;
  locked: boolean;
  label: string;
}

const Review = () => {
  const { pendingId = '' } = useParams<{ pendingId: string }>();
  const [searchParams] = useSearchParams();
  const botsParam = searchParams.get('bots') || '';

  const { data, isLoading, error } = useQuery({
    queryKey: ['meegoPending', pendingId],
    queryFn: () => meegoBridge.getMeegoPending(pendingId),
    retry: false,
  });

  // CodeM 默认勾选；卡片带入 bots=none 时不勾选
  const [codemChecked, setCodemChecked] = useState(botsParam !== 'none');
  const [includeMe, setIncludeMe] = useState(true);
  const [extraBots, setExtraBots] = useState<BotRow[]>([]);
  const [membersText, setMembersText] = useState('');
  const [result, setResult] = useState<ConfirmGroupResult | null>(null);

  const confirmMutation = useMutation({
    mutationFn: () =>
      meegoBridge.confirmMeegoGroup({
        pendingId,
        bots: [
          ...(codemChecked ? [CODEM_BOT_APP_ID] : []),
          ...extraBots
            .filter((row: BotRow) => row.checked)
            .map((row: BotRow) => row.appId.trim())
            .filter(Boolean),
        ],
        includeMe,
        members: membersText
          .split('\n')
          .map((s: string) => s.trim())
          .filter(Boolean),
      }),
    retry: false,
    onSuccess: (res: ConfirmGroupResult) => {
      setResult(res);
    },
  });

  const addBotRow = (): void => {
    setExtraBots((rows: BotRow[]) => [
      ...rows,
      {
        key: Date.now(),
        appId: '',
        checked: true,
        locked: false,
        label: '其他机器人',
      },
    ]);
  };

  if (isLoading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center text-sm text-muted-foreground">
        加载草稿中...
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-2 text-sm text-destructive">
        <p>草稿加载失败：{error instanceof Error ? error.message : '不存在或已过期'}</p>
      </div>
    );
  }
  if (result) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 p-6">
        <h1 className="text-xl font-semibold">
          {result.mode === 'update' ? '✅ 群已更新' : '✅ 群已创建'}
        </h1>
        <Card className="space-y-2 p-4 text-sm">
          <p>
            群名：<b>{result.chatName}</b>
          </p>
          <p>
            新增成员：{result.usersAdded}；新增机器人：{result.botsAdded}
          </p>
          {result.alreadyInChat.length > 0 && (
            <p>已在群内跳过：{result.alreadyInChat.join('、')}</p>
          )}
          <p>变更字段消息：{result.changedMessageSent ? '已发送到群内' : '发送失败（见服务日志）'}</p>
          {result.unresolvedMembers.length > 0 && (
            <p className="text-destructive">
              未解析成功（请改传 ou_ 开头的 open_id）：{result.unresolvedMembers.join('、')}
            </p>
          )}
          <a
            className="text-primary underline"
            href={result.chatLink}
            target="_blank"
            rel="noreferrer"
          >
            打开群聊
          </a>
        </Card>
      </div>
    );
  }

  const isUpdate = data.mode === 'update';
  const changedLines = (data.changedText || '').split('\n').filter(Boolean);

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <div className="flex items-center gap-2">
        <h1 className="text-xl font-semibold">
          {isUpdate ? '群已存在，进入更新确认' : 'Meego 工作项建群确认'}
        </h1>
        <Badge variant={isUpdate ? 'secondary' : 'default'}>
          {isUpdate ? 'update' : 'create'}
        </Badge>
      </div>

      <Card className="space-y-2 p-4 text-sm">
        <p>
          工作项：{data.workItemType}#{data.workItemId}「{data.workItemName ?? ''}」
          {data.project ? `（空间：${data.project}）` : ''}
        </p>
        <p className="text-muted-foreground">
          草稿状态：{data.status === 'pending' ? '待确认' : '已处理'}
        </p>
        <p className="font-medium">变更字段：</p>
        <pre className="whitespace-pre-wrap rounded bg-muted p-3 text-xs leading-relaxed">
          {changedLines.slice(1).join('\n') || '（无）'}
        </pre>
        {isUpdate && (
          <p className="text-muted-foreground">
            该工作项已有群，确认后：新勾选的机器人/成员拉入已有群（已在群内自动跳过），
            变更信息发送到群内，不会新建群。
          </p>
        )}
      </Card>

      <Card className="space-y-4 p-4 text-sm">
        <div className="flex items-center gap-2">
          <Checkbox
            id="codem-bot"
            checked={codemChecked}
            onCheckedChange={(v) => setCodemChecked(v === true)}
            aria-label="拉入飞书 CodeM 机器人"
          />
          <Label htmlFor="codem-bot" className="flex items-center gap-1">
            拉入飞书 CodeM 机器人
            <code className="rounded bg-muted px-1 text-xs">{CODEM_BOT_APP_ID}</code>
          </Label>
        </div>

        {extraBots.map((row: BotRow) => (
          <div key={row.key} className="flex items-center gap-2">
            <Checkbox
              checked={row.checked}
              onCheckedChange={(v) =>
                setExtraBots((rows: BotRow[]) =>
                  rows.map((r: BotRow) =>
                    r.key === row.key ? { ...r, checked: v === true } : r,
                  ),
                )
              }
              aria-label={`拉入其他机器人 ${row.appId || row.key}`}
            />
            <Input
              value={row.appId}
              placeholder="cli_xxxxxxxxxx（其他机器人 app_id）"
              onChange={(e) =>
                setExtraBots((rows: BotRow[]) =>
                  rows.map((r: BotRow) =>
                    r.key === row.key ? { ...r, appId: e.target.value } : r,
                  ),
                )
              }
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label="移除该机器人"
              onClick={() =>
                setExtraBots((rows: BotRow[]) =>
                  rows.filter((r: BotRow) => r.key !== row.key),
                )
              }
            >
              ✕
            </Button>
          </div>
        ))}
        <Button variant="outline" onClick={addBotRow}>
          + 添加其他机器人
        </Button>

        <div className="flex items-center gap-2">
          <Checkbox
            id="include-me"
            checked={includeMe}
            onCheckedChange={(v) => setIncludeMe(v === true)}
            aria-label="把我拉进群"
          />
          <Label htmlFor="include-me">把我拉进群（群主/确认人）</Label>
        </div>

        <div className="space-y-2">
          <Label htmlFor="members">额外成员（每行一个 ou_ 开头的 open_id）</Label>
          <Textarea
            id="members"
            value={membersText}
            placeholder={'ou_xxxxxxxxxxxxxxxx'}
            onChange={(e) => setMembersText(e.target.value)}
          />
        </div>

        <div className="flex items-center gap-3">
          <Button
            disabled={confirmMutation.isPending || data.status !== 'pending'}
            onClick={() =>
              confirmMutation.mutate(undefined, {
                onError: (err: Error) => {
                  logger.error('确认建群失败', err);
                },
              })
            }
          >
            {confirmMutation.isPending
              ? '执行中...'
              : isUpdate
                ? '确认更新群'
                : '确认创建群聊'}
          </Button>
          {confirmMutation.isError && (
            <span className="text-xs text-destructive">
              {(confirmMutation.error as { response?: { data?: { error?: { message?: string } } } })?.response?.data
                ?.error?.message || '执行失败，请重试'}
            </span>
          )}
        </div>
      </Card>
    </div>
  );
};

export default Review;
