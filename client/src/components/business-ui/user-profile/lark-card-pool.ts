/**
 * 飞书名片 `<tt-profile>` 的 DOM 池。
 *
 * 为什么 DOM 能被复用：
 * 飞书 h5-js-sdk 的 `tt-profile` 在 `customRender()` 里把 React 渲染进元素自身
 * （`ReactDOM.render(..., this)`），但 `disconnectedCallback()` 卸载的是
 * `this.shadowRoot` —— 两者不是同一个节点，`unmountComponentAtNode` 打空，
 * 所以把元素从文档里摘下来并不会销毁它的内容。又因为基类的 `componentRender()`
 * 被 `_hasMounted` 一次性闸门挡住，重新挂回文档也不会触发二次渲染。
 * 净效果：摘下来存着、下次挂回去，内容原样还在，且不会重新发请求。
 *
 * ⚠️ 这依赖 SDK 当前实现（h5-js-sdk 1.2.21）。升级 SDK 后必须重新验证：
 * 把一个已渲染的 `<tt-profile>` `remove()` 再 `appendChild()` 回去，
 * 内容是否仍在、交互是否仍可用。失效时本模块应整体降级为「每次重建」。
 */

/** 池容量上限，超出按最近使用顺序淘汰 */
/* 暂时放大到 20：观察同时备更多人时的内存与渲染开销，确认后再定最终值 */
let maxEntries = 20;

/**
 * 调整缓存策略：需要同时备好更多人的卡片时调大 maxEntries。
 *
 * 没有 TTL —— 每次打开都会重新渲染一次做更新，备用卡只决定「打开瞬间
 * 显示什么」，不决定数据新鲜度。
 */
export function configureCardPool(options: { maxEntries?: number }): void {
  if (typeof options.maxEntries === 'number') maxEntries = options.maxEntries;
}

/** 飞书名片渲染完成的标志节点：姓名有文字即认为内容已就绪（骨架屏阶段为空） */
const READY_SELECTOR = '.larkw-userprofile__profile__alias-or-username-text';

/** 等待渲染完成的上限，超时按失败处理，不替换当前展示的卡片 */
const READY_TIMEOUT_MS = 8 * 1000;

/**
 * 备用卡池：每个 openId 一张**已渲染好、但从未显示过**的活 `<tt-profile>`，
 * 停在离屏容器里。
 *
 * 为什么不直接缓存用户看过的那张：活元素会被用户操作 —— 滚动、点进上级的
 * 名片、点开个性签名编辑框。这些状态一半在 DOM（inline 样式，能读能写），
 * 一半在飞书 React 的内部 state（外部读不到也写不回）。既然无法可靠地把它
 * 恢复成初始态，就干脆不复用它，而是另外备一张从没被碰过的。
 *
 * 代价是一个开关周期要渲染两次：一次换上去做更新，一次补充下次的备用卡。
 */
const pool = new Map<string, Element>();

/** 取走某人的备用卡（取走即消耗，调用方负责挂载）。没有则返回 null。 */
export function takeSpare(openId: string): Element | null {
  const spare = pool.get(openId);
  if (!spare) return null;
  pool.delete(openId);
  return spare;
}

/**
 * 停放一张备用卡。元素应当停留在离屏容器里，不要挂进可见区域 ——
 * 一旦被用户看到就可能被操作，就不再是初始态了。
 */
export function putSpare(openId: string, live: Element): void {
  pool.get(openId)?.remove();
  pool.delete(openId);
  pool.set(openId, live);

  while (pool.size > maxEntries) {
    const oldest = pool.keys().next().value;
    if (oldest === undefined) break;
    pool.get(oldest)?.remove();
    pool.delete(oldest);
  }
}

/** 某人是否已经备好卡（用于决定要不要补渲染） */
export function hasSpare(openId: string): boolean {
  return pool.has(openId);
}

/** 同一个人同时在途的渲染任务，用于去重 */
const inflight = new Map<string, Promise<Element | null>>();

/**
 * 保证同一个人同时只有一次渲染在途：重复调用复用同一个 Promise。
 *
 * 这不是优化而是正确性要求 —— effect 会被重复执行（React dev 下的双调用、
 * 依赖变化、popover 快速开关），没有这层去重就会创建出多个 `<tt-profile>`，
 * 每个都往飞书发一次请求。
 *
 * key 由调用方给 —— 同一个人的「打开后更新」和「补充备用卡」是两件独立的
 * 事，不能互相去重，所以用 `<openId>:update` / `<openId>:spare` 区分。
 */
export function ensureRender(
  key: string,
  create: () => Promise<Element | null>,
): Promise<Element | null> {
  const existing = inflight.get(key);
  if (existing) return existing;

  const task = create().finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, task);
  return task;
}

/** 丢弃某人的备用卡（渲染出错或需要强制重建时） */
export function dropSpare(openId: string): void {
  pool.get(openId)?.remove();
  pool.delete(openId);
}

/** 清空整个池。页面级登出 / 切租户时调用。 */
export function clearCardPool(): void {
  pool.forEach((el) => {
    el.remove();
  });
  pool.clear();
}

/**
 * 等待一个 `<tt-profile>` 从骨架屏变成真实内容。
 * 超时返回 false —— 调用方据此放弃替换，继续展示旧卡片。
 */
export function waitForCardReady(
  el: Element,
  timeoutMs: number = READY_TIMEOUT_MS,
): Promise<boolean> {
  const isReady = () => {
    const node = el.querySelector(READY_SELECTOR);
    return Boolean(node?.textContent?.trim());
  };

  if (isReady()) return Promise.resolve(true);

  return new Promise<boolean>((resolve) => {
    const observer = new MutationObserver(() => {
      if (!isReady()) return;
      clearTimeout(timer);
      observer.disconnect();
      resolve(true);
    });

    const timer = setTimeout(() => {
      observer.disconnect();
      resolve(false);
    }, timeoutMs);

    observer.observe(el, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
}

/**
 * 取「卡片里本人那一屏」的文字，用来判断本人的数据有没有被改动过。
 *
 * 不能直接用整张卡的 textContent —— 飞书名片是个卡片栈，用户点进上级的
 * 名片时会往里压入第二屏，整张卡的文字就变了，但**本人的数据一个字没动**。
 * 把那种情况误判成「数据变了」会白白丢弃备用卡，下次打开退回完整 loading。
 *
 * 栈里第一个 `.larkw-userprofile__manager__profile` 就是本人那一屏。
 * 找不到这个结构时退回整张卡，宁可偶尔多丢一次缓存，也不要漏掉真实改动。
 */
export function ownProfileText(el: Element): string {
  const own =
    el.querySelector('.larkw-userprofile__manager__profile') ?? el;
  return own.textContent?.trim() ?? '';
}

const OFFSCREEN_ID = 'lark-profile-offscreen';

/**
 * 离屏渲染容器：后台渲染的 `<tt-profile>` 先在这里成形，就绪后再挂到
 * 可见位置，这样用户看不到骨架屏。
 *
 * 用绝对定位移出视口而不是 `display:none` —— 后者会让元素没有布局盒，
 * 飞书名片内部依赖尺寸的逻辑可能不工作。
 */
/**
 * 为「一次渲染」开一个专属的离屏插槽。
 *
 * SDK 的 render() 只是把元素 append 到给定容器，不返回它，我们只能从容器
 * 里取。多次渲染共用一个容器时（命中备用卡后，「打开后更新」和「预备下一张」
 * 是并发的；一页多张卡片时更多），谁 append 在前无法保证，按「最后一个子节点」
 * 取会张冠李戴 —— 两次渲染可能拿到同一个元素，甚至取到别人的名片。
 *
 * 每次渲染独占一个插槽，容器里就只会有本次创建的那一个。
 */
export function createOffscreenSlot(): HTMLElement {
  const slot = document.createElement('div');
  getOffscreenHost().appendChild(slot);
  return slot;
}

export function getOffscreenHost(): HTMLElement {
  const existing = document.getElementById(OFFSCREEN_ID);
  if (existing) return existing;

  const host = document.createElement('div');
  host.id = OFFSCREEN_ID;
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = [
    'position:absolute',
    'top:0',
    'left:-10000px',
    'width:320px',
    'height:520px',
    'overflow:hidden',
    'pointer-events:none',
  ].join(';');
  document.body.appendChild(host);
  return host;
}
