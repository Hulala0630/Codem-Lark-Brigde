'use client';

import { logger } from '@lark-apaas/client-toolkit/logger';

import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import SHA1 from 'crypto-js/sha1';

import { getAssetsUrl } from '@client/src/components/business-ui/api/user-profiles/service';
import { useUserProfile } from '@client/src/components/business-ui/api/user-profiles/queries';
import { ErrorImage } from '@client/src/components/business-ui/user-profile/error-image';
import {
  dropSpare,
  ownProfileText,
  ensureRender,
  createOffscreenSlot,
  getOffscreenHost,
  hasSpare,
  putSpare,
  takeSpare,
  waitForCardReady,
} from '@client/src/components/business-ui/user-profile/lark-card-pool';
import { getEnv } from '@lark-apaas/client-toolkit/utils/getEnv';
import { useExternalScript } from '@client/src/components/business-ui/user-profile/user-external-script';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { UserInput } from '@client/src/components/business-ui/types/user';

type WebComponentAPI = {
  config(params: {
    openId: string;
    signature: string;
    appId: string;
    timestamp: string;
    nonceStr: string;
    url: string;
    jsApiList: string[];
    locale?: string[];
    env?: string;
  }): Promise<void>;
  render(
    name: string,
    props: Record<string, unknown>,
    container: HTMLElement | null,
  ): Promise<unknown>;
  onAuthError(cb: (error: Error) => void): void;
  onError(cb: (error: Error) => void): void;
};

declare global {
  // 运行环境标识（可根据需要扩展实际取值范围）
  var ENVIRONMENT: 'staging' | 'local' | 'production' | string;
  // 飞书 H5 webComponent SDK
  var webComponent: WebComponentAPI;
}

interface UserProfileProps {
  readonly value?: string | UserInput;
  readonly userId?: string | undefined;
  readonly user_id?: string | undefined;
  readonly accountType?: 'apaas' | 'lark' | undefined;
}

function generateRandomString(length: number): string {
  const characters =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';

  for (let i = 0; i < length; i += 1) {
    const randomIndex = Math.floor(Math.random() * characters.length);
    result += characters.charAt(randomIndex);
  }

  return result;
}

const ACCOUNT_STATUS = {
  UNSPECIFIED: 0,
  Inactive: 1,
  Active: 2,
  Disabled: 3,
  Terminated: 4,
  NotJoined: 5,
  Resigned: 6,
} as const;
type AccountStatus = (typeof ACCOUNT_STATUS)[keyof typeof ACCOUNT_STATUS];

const AccountStatusMap: Record<AccountStatus, string> = {
  [ACCOUNT_STATUS.UNSPECIFIED]: '',
  [ACCOUNT_STATUS.Active]: '已启用',
  [ACCOUNT_STATUS.Inactive]: '未激活',
  [ACCOUNT_STATUS.Disabled]: '已停用',
  [ACCOUNT_STATUS.Terminated]: '已停用',
  [ACCOUNT_STATUS.NotJoined]: '未激活',
  [ACCOUNT_STATUS.Resigned]: '已停用',
};

interface SimpleProfileInfo {
  readonly name?: string;
  readonly avatar?: string;
  readonly email?: string;
  readonly userStatus: AccountStatus;
  readonly userType: '_employee' | '_externalUser';
}

interface SimpleProfileData {
  readonly useLarkCard: false;
  readonly userProfileInfo: SimpleProfileInfo;
}

interface OfficialProfileData {
  readonly useLarkCard: true;
  readonly larkCardParam: LarkCardParam;
}

interface LarkCardParam {
  readonly needRedirect?: boolean;
  readonly redirectURL?: string;
  readonly larkAppID: string;
  readonly jsAPITicket: string;
  readonly larkOpenID: string;
  readonly targetLarkOpenID: string;
}

/**
 * 通用响应结构
 * 用于标准化 API 响应格式
 */
export interface WithCommonResponse<T> {
  data: T;
}

// 按需注入飞书 H5 JS SDK，仅在走飞书名片分支时才加载
const LARK_SDK_URL =
  'https://lf3-cdn-tos.bytegoofy.com/obj/goofy/locl/lark/external_js_sdk/h5-js-sdk-1.2.21.js';

/**
 * 鉴权重定向地址放在模块级而不是组件 ref 里。
 * 原因：useExternalScript 在「脚本已存在」时会跳过 onloadCallback，
 * 所以 onAuthError 只会在页面首个实例挂载时注册一次。若闭包捕获的是
 * 某个实例的 ref，该实例卸载后，后续实例的 redirectURL 就永远送不到
 * 已注册的 handler 里。用模块级变量保证读到的始终是最新值。
 */
let currentRedirectURL = '';
let authHandlerRegistered = false;

function registerLarkAuthHandler(): void {
  if (authHandlerRegistered) return;
  if (typeof globalThis.webComponent === 'undefined') return;
  authHandlerRegistered = true;

  globalThis.webComponent.onAuthError(function (error: Error) {
    let errorMessage: { msg?: { code?: number; msg?: string } } | undefined;
    try {
      errorMessage = JSON.parse(error.message);
    } catch {
      logger.info('webComponent onAuthError: 非 JSON 错误体', error);
      return;
    }
    // 存在token过期情况，但后端无法识别，需要前端这边主动识别error，并进行鉴权重定向
    if (
      errorMessage?.msg?.code === 20442 &&
      errorMessage?.msg?.msg === 'jsapi-ticket not exist' &&
      currentRedirectURL
    ) {
      globalThis.location.replace(currentRedirectURL);
    }
  });

  globalThis.webComponent.onError(function (error: Error) {
    logger.info('webComponent onError', error);
  });
}

/** 在指定容器里创建并渲染一个飞书名片，返回创建出来的 `<tt-profile>` 元素 */
async function renderLarkProfile(
  param: LarkCardParam,
  host: HTMLElement,
): Promise<Element | null> {
  const { larkAppID, jsAPITicket, larkOpenID, targetLarkOpenID } = param;

  const timestamp = Date.now().toString();
  const nonceStr = generateRandomString(10);
  const url = globalThis.location.href.split('#')[0] ?? '';
  const message = `jsapi_ticket=${jsAPITicket}&noncestr=${nonceStr}&timestamp=${timestamp}&url=${url}`;
  const signature = SHA1(message).toString();

  await globalThis.webComponent.config({
    openId: larkOpenID,
    signature,
    appId: larkAppID,
    timestamp,
    nonceStr,
    url,
    jsApiList: ['user_profile'],
    locale: ['zh_cn'],
    ...(getEnv() === 'BOE' ? { env: 'feishu_boe' } : {}),
  });

  await globalThis.webComponent.render(
    'UserProfile',
    { openId: targetLarkOpenID },
    host,
  );

  // SDK 把 <tt-profile> append 到 host 上，取最后一个即本次创建的
  return host.lastElementChild;
}

/**
 * 渲染一张完整可用的名片。
 *
 * `visibleHost` 非空时直接渲进可见容器（首次打开，让用户看到飞书自己的骨架屏）；
 * 否则开一个专属离屏插槽 —— 并发渲染共用容器会取错元素。插槽只用来隔离本次
 * 渲染，拿到元素后就把它挪到离屏容器下并撤掉插槽，否则空壳 div 会累积。
 *
 * 放在模块级而不是 effect 内，是为了让「真正卸载时补备用卡」那条路径也能用，
 * 不必把它写进 effect 的闭包、从而被迫放宽依赖。
 */
async function renderCard(
  param: LarkCardParam,
  visibleHost: HTMLElement | null,
): Promise<Element | null> {
  const slot = visibleHost ? null : createOffscreenSlot();
  const live = await renderLarkProfile(param, visibleHost ?? slot!);

  const settle = () => {
    if (!slot) return;
    if (live && live.parentNode === slot) getOffscreenHost().appendChild(live);
    slot.remove();
  };

  if (!live) {
    settle();
    return null;
  }
  if (!(await waitForCardReady(live))) {
    live.remove();
    settle();
    return null;
  }
  settle();
  return live;
}

function UserProfile(props: UserProfileProps) {
  const { value, userId: originUserId, user_id, accountType = 'apaas' } = props;

  const userId =
    (typeof value === 'string'
      ? value
      : (value as any)?.user_id || (value as any)?.userId) ||
    user_id ||
    originUserId;

  const { data, isPending, isError, refetch } = useUserProfile({
    userId: userId ?? '',
    accountType,
    enabled: Boolean(userId),
  });

  const handleRetry = useCallback(() => {
    void refetch();
  }, [refetch]);

  // 没有 userId 时不渲染任何东西。旧实现在这里会停在 loading 上永远转圈。
  if (!userId) return null;

  if (isError) {
    return (
      <Card className="flex min-h-124 w-80 flex-col items-center justify-center gap-4 border-0 p-0">
        <ErrorImage />
        <div>
          <span className="text-sm">加载失败 请</span>
          <Button
            size="sm"
            variant="ghost"
            className="pr-1 pl-1 text-primary! not-disabled:hover:bg-primary/10 not-disabled:hover:text-primary/90 focus-visible:bg-primary/20"
            onClick={handleRetry}
          >
            重试
          </Button>
        </div>
      </Card>
    );
  }

  // isPending 只在「无缓存且首次请求中」为真。
  // 命中缓存时直接跳过 loading，卡片零延迟出现，后台静默 revalidate。
  if (isPending || !data) {
    return (
      <Card className="flex h-130 w-80 flex-col items-center justify-center gap-6 border-0 p-0">
        <Spinner className="size-8 animate-spin text-primary" />
      </Card>
    );
  }

  // 业务仓的 tsconfig 继承自 fullstack-presets，是 strictNullChecks: false。
  // TS 在该模式下不做判别联合窄化（本地现写的同形状联合一样窄化失败），
  // 所以这里必须显式断言分支类型，不能简化成 data.userProfileInfo。
  if (!data.useLarkCard) {
    const { userProfileInfo } = data as SimpleProfileData;
    return <SimpleUserProfile userProfileInfo={userProfileInfo} />;
  }

  const { larkCardParam } = data as OfficialProfileData;
  // key 绑 openId：切换到另一个人时整个重挂，备用卡引用、文字基线、loading
  // 状态一并重置。否则 spareRef 的 `??=` 会把上一个人的卡片留下来复用。
  return (
    <LarkProfileCard
      key={larkCardParam.targetLarkOpenID}
      larkCardParam={larkCardParam}
    />
  );
}

/**
 * 飞书名片分支。
 *
 * 人员数据由 `<tt-profile>` 自己拉取，不经过我们的 state，因此这里无法做
 * 字段级的 stale-while-revalidate。退而求其次：缓存整个已渲染的 DOM，
 * 命中即刻展示；内容陈旧时在离屏容器里渲染一份新的，就绪后整体替换，
 * 这样换新过程中用户看到的始终是旧卡片，不会出现骨架屏。
 */
function LarkProfileCard(props: { readonly larkCardParam: LarkCardParam }) {
  const { larkCardParam } = props;
  const { needRedirect, redirectURL, targetLarkOpenID } = larkCardParam;

  // 「打开后更新」渲染出的元素由本实例独占 —— 它会被 attach 进本实例的容器，
  // 取消时也由本实例回收。所以去重必须按实例隔离：ensureRender 的 key 是模块级的，
  // 同一个人的两个实例共享一次渲染的话，两边会拿到同一个 DOM 元素，
  // 后挂载的那个会把节点从前一个容器里抢走（前者变空白），先卸载的那个
  // 还会把另一个正在显示的节点 remove 掉。
  //
  // 备用卡池仍然按人共享 —— 那条路径是 takeSpare 独占领取，不存在同一元素
  // 被两个实例同时持有的问题。
  const instanceId = useId();

  const hostRef = useRef<HTMLDivElement>(null);
  // 初值在渲染期就定下来：有备用卡就不该出现转圈。effect 在首次绘制之后
  // 才跑，若初值恒为 true，命中缓存也会先闪一帧 loading。
  const [showSpinner, setShowSpinner] = useState(() =>
    !hasSpare(targetLarkOpenID),
  );
  const [renderFailed, setRenderFailed] = useState(false);
  const [retryToken, setRetryToken] = useState(0);

  // 这次挂载取到的备用卡。takeSpare 是「取走」语义，effect 可能重复执行，
  // 不记在 ref 里第二次就拿不到，会误判成没有缓存而走完整 loading。
  const spareRef = useRef<Element | null>(null);
  // 当前挂在容器里的那一张。卸载清理要用它，而那时 hostRef 可能已被置空。
  const shownRef = useRef<Element | null>(null);
  // 挂上那一刻、本人那一屏的文字。卸载时比对，判断用户有没有改过本人的数据。
  const attachedTextRef = useRef<string>('');
  // 组件是否还活着。异步回调的归属是「组件实例」而不是「某一次 effect 执行」，
  // 所以用它而不是 effect 内的 cancelled 标志 —— 否则依赖一变化，正在途中的
  // 渲染结果就会被当成已取消而丢弃。
  const aliveRef = useRef(true);
  // 已经为哪一轮 retryToken 启动过渲染，保证依赖变化时不重复发起。
  const startedRef = useRef(-1);

  const scriptOptions = useMemo(
    () => ({ onloadCallback: registerLarkAuthHandler }),
    [],
  );
  const scriptStatus = useExternalScript(LARK_SDK_URL, scriptOptions);

  // 卸载清理需要的值走 ref，避免为了它们把依赖写宽
  const teardownRef = useRef({ param: larkCardParam, scriptReady: false });
  teardownRef.current = {
    param: larkCardParam,
    scriptReady: scriptStatus === 'ready',
  };

  // 需要走鉴权重定向时整页跳转，不渲染名片
  useEffect(() => {
    if (needRedirect && redirectURL) {
      globalThis.location.replace(redirectURL);
    }
  }, [needRedirect, redirectURL]);

  /**
   * 只在**真正卸载**时回收。
   *
   * 不能放进主 effect 的 cleanup —— 那个 cleanup 在任何依赖变化时都会跑
   * （scriptStatus 从 loading 变 ready、react-query 刷新导致 larkCardParam
   * 换引用，都是必经路径）。在那里 remove 掉正在显示的卡片，会造成可见的
   * 闪白回退，而且被摘掉的若是「打开后更新」那张，它既不在池里也不在容器里，
   * 直接成了孤儿。
   */
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;

      const shown = shownRef.current;
      shownRef.current = null;
      if (!shown) return;

      const changed = ownProfileText(shown) !== attachedTextRef.current;
      // 用过的那张直接丢弃 —— 它可能被滚动过、点进过别人的名片，
      // 而这些状态有一半在飞书 React 内部，无法可靠恢复
      shown.remove();

      const { param, scriptReady } = teardownRef.current;
      if (!changed || !scriptReady) return;

      // 用户在卡片里改过本人的数据（最典型的是编辑个性签名）。已经备好的那张
      // 是改动之前渲染的，内容已过时：丢掉，并立刻重新备一张 —— 只丢不补的话
      // 下次打开会退回完整 loading。带时间戳的 key 绕开去重，确保拿到的是
      // 改动之后重新渲染的结果。
      dropSpare(param.targetLarkOpenID);
      void ensureRender(
        `${param.targetLarkOpenID}:spare:${String(Date.now())}`,
        async () => {
          const live = await renderCard(param, null);
          if (live) putSpare(param.targetLarkOpenID, live);
          return live;
        },
      ).catch((error: unknown) => {
        logger.info('re-prepare spare lark profile failed', error);
      });
    };
  }, []);

  // 主逻辑。对重复执行幂等：已经挂了东西就不再顶备用卡，已经发起过的渲染
  // 不重复发起。
  useEffect(() => {
    if (needRedirect) return;

    const host = hostRef.current;
    if (!host) return;

    currentRedirectURL = redirectURL ?? '';
    // 脚本已存在时 useExternalScript 会跳过 onloadCallback，这里补注册一次
    if (scriptStatus === 'ready') registerLarkAuthHandler();

    const attach = (el: Element | null) => {
      if (!aliveRef.current || !el) return;
      host.replaceChildren(el);
      shownRef.current = el;
      attachedTextRef.current = ownProfileText(el);
      setShowSpinner(false);
      setRenderFailed(false);
    };

    if (!shownRef.current) {
      // 备用卡是渲染好后一直停在离屏、从没显示过的，所以必然是初始态，
      // 而且是活元素 —— 挂上即可交互，不是静态快照
      spareRef.current ??= takeSpare(targetLarkOpenID);
      if (spareRef.current) attach(spareRef.current);
    }

    if (scriptStatus !== 'ready') return;
    if (startedRef.current === retryToken) return;
    startedRef.current = retryToken;

    const hadSpare = Boolean(shownRef.current);
    if (!hadSpare) setShowSpinner(true);

    // 打开后更新一次：再渲染一张，就绪后换上去，让这次看到的是最新数据。
    // 有备用卡顶着就离屏渲染（用户看不到骨架屏），没有就直接渲进可见容器。
    void ensureRender(
      `${targetLarkOpenID}:update:${instanceId}:${String(retryToken)}`,
      () => renderCard(larkCardParam, hadSpare ? null : host),
    )
      .then((live) => {
        if (!aliveRef.current) {
          // 组件已卸载。元素此时在常驻离屏容器里，既不会被 attach 也不进
          // 受 maxEntries 约束的池 —— 放着不管会随反复开关一直累积。
          live?.remove();
          return;
        }
        if (live) {
          attach(live);
          return;
        }
        // 渲染没能就绪。已经挂着备用卡就保持现状；什么都没有的话必须收掉
        // loading 并给出重试入口，否则会一直转圈。
        if (!shownRef.current) {
          setShowSpinner(false);
          setRenderFailed(true);
        }
      })
      .catch((error: unknown) => {
        logger.info('update lark profile failed', error);
        if (!aliveRef.current) return;
        setShowSpinner(false);
        if (!shownRef.current) setRenderFailed(true);
      });

    // 立刻开始备下一张。必须在「打开」时做而不是「关闭」时 —— 真实环境渲染
    // 一张要走鉴权、render、网关取数、图片加载，几秒起步；放在关闭时做的话，
    // 用户点快一点下次打开就还没备好，又掉回完整 loading。
    if (!hasSpare(targetLarkOpenID)) {
      void ensureRender(`${targetLarkOpenID}:spare`, async () => {
        const live = await renderCard(larkCardParam, null);
        if (live) putSpare(targetLarkOpenID, live);
        return live;
      }).catch((error: unknown) => {
        logger.info('prepare spare lark profile failed', error);
      });
    }
  }, [
    instanceId,
    larkCardParam,
    needRedirect,
    redirectURL,
    retryToken,
    scriptStatus,
    targetLarkOpenID,
  ]);

  const handleRetryRender = useCallback(() => {
    setRenderFailed(false);
    setShowSpinner(true);
    setRetryToken((n) => n + 1);
  }, []);

  if (needRedirect) return null;

  return (
    <Card className="relative flex h-130 w-80 flex-col items-center justify-center gap-6 border-0 p-0">
      <div ref={hostRef} className="h-full w-full" />
      {showSpinner && (
        <Spinner className="absolute size-8 animate-spin text-primary" />
      )}
      {renderFailed && (
        <div className="absolute flex flex-col items-center gap-4">
          <ErrorImage />
          <div>
            <span className="text-sm">加载失败 请</span>
            <Button
              size="sm"
              variant="ghost"
              className="pr-1 pl-1 text-primary! not-disabled:hover:bg-primary/10 not-disabled:hover:text-primary/90 focus-visible:bg-primary/20"
              onClick={handleRetryRender}
            >
              重试
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function SimpleUserProfile(props: {
  readonly userProfileInfo: SimpleProfileInfo;
}) {
  const { userProfileInfo } = props;

  return (
    <Card className="flex w-80 flex-col gap-0 overflow-hidden border-0 p-0">
      <div className="relative h-34 w-full">
        <img
          src={getAssetsUrl(
            '/obj/eden-cn/lm-zhhwh/ljhwZthlaukjlkulzlp/ui/bg.png',
          )}
          alt="cover"
          className="absolute inset-0 h-full w-full object-cover"
          loading="lazy"
          width={320}
          height={112}
        />
      </div>

      <CardContent className="h-96 w-80 pt-0 pr-4 pb-4 pl-4">
        <div className="relative">
          <Avatar className="absolute left-0 size-22.5 -translate-y-1/2 border-2 border-background">
            <AvatarImage
              src={userProfileInfo.avatar}
              alt={userProfileInfo.name}
            />
            <AvatarFallback>{userProfileInfo.name?.at(0)}</AvatarFallback>
          </Avatar>

          <div className="pt-13.5">
            <div className="flex items-center gap-2 pt-0.5 pb-1.5 leading-tight font-semibold">
              <span className="text-xl">{userProfileInfo.name}</span>
              {userProfileInfo.userType === '_externalUser' && (
                <Badge className="rounded-sm border-0 bg-blue-500/20 pt-px pr-1.5 pb-px pl-1 text-sm text-blue-900">
                  外部
                </Badge>
              )}
              {AccountStatusMap[userProfileInfo.userStatus] !== '' && (
                <Badge className="rounded-sm border-0 bg-foreground/10 pt-px pr-1.5 pb-px pl-1 text-sm text-foreground">
                  {AccountStatusMap[userProfileInfo.userStatus]}
                </Badge>
              )}
            </div>
            {userProfileInfo.email && (
              <div className="mt-6 grid grid-cols-[84px_1fr] gap-y-3 text-sm">
                <div className="text-muted-foreground">邮箱</div>
                <div>
                  <a
                    className="break-all text-primary underline-offset-4 hover:underline"
                    href={`mailto:${userProfileInfo.email ?? ''}`}
                  >
                    {userProfileInfo.email}
                  </a>
                </div>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export { UserProfile };
