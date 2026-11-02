'use client';

import { useQuery, queryOptions, type QueryClient } from '@tanstack/react-query';

import { fetchUserProfile, type AccountType } from './service';

export const userProfileQueries = {
  all: () => ['userProfiles'] as const,
  byId: (userId: string, accountType: AccountType = 'apaas') =>
    queryOptions({
      queryKey: [...userProfileQueries.all(), 'byId', accountType, userId],
      queryFn: ({ signal }) => fetchUserProfile(userId, accountType, signal),
      // staleTime 0：每次打开都在后台取一次新的，和飞书名片那条路保持一致
      // ——「打开渲染缓存、后台乐观更新」。缓存命中时 isPending 为 false，
      // 卡片瞬间渲出不转圈；新数据回来后 React 只 patch 变化的字段，不闪不跳。
      //
      // 之前是 60s：那段窗口内连请求都不发，远端改了最多要等 60 秒才看得到。
      staleTime: 0,
      // gcTime 决定缓存能留多久 —— 它才是「秒出」的来源，不要跟着一起调小。
      gcTime: 5 * 60 * 1000,
      enabled: !!userId,
    }),
};

export type UseUserProfileOptions = {
  userId: string;
  accountType?: AccountType;
  enabled?: boolean;
};

/**
 * 获取用户 Profile 卡片数据的 hook
 */
export function useUserProfile(options: UseUserProfileOptions) {
  const { userId, accountType = 'apaas', enabled = true } = options;

  return useQuery({
    ...userProfileQueries.byId(userId, accountType),
    enabled: enabled && !!userId,
  });
}

/**
 * 清除用户 Profile 缓存
 */
export function clearUserProfileCache(queryClient: QueryClient): void {
  queryClient.invalidateQueries({ queryKey: userProfileQueries.all() });
}
