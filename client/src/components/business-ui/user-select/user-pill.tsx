'use client';

import React from 'react';

import {
  ItemPill,
  renderPillAvatar,
} from '@client/src/components/business-ui/entity-combobox/item-pill';
import type { ComboboxSize } from '@client/src/components/business-ui/entity-combobox/size-variants';
import { UserProfile } from '@client/src/components/business-ui/user-profile/user-profile';
import type { AccountType } from '@client/src/components/business-ui/user-select/types';
import { cn } from '@/lib/utils';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@client/src/components/ui/popover';

/**
 * 阻止 Popover 打开时的自动聚焦。
 *
 * Radix 的 FocusScope 在弹层挂载时会把焦点给容器里第一个可聚焦元素。人员卡片
 * 挂载那一刻内容就已经在了（飞书名片里有「消息」等按钮），于是一打开就有个
 * 按钮带上焦点环。这是张只读预览卡，焦点应该留在触发器上 —— Radix 自己的
 * HoverCard 也是这么处理的。
 */
const handleProfileOpenAutoFocus = (event: Event) => {
  event.preventDefault();
};

export type UserPillProps = {
  /**
   * 用户 ID，用于 UserProfile 展示
   */
  userId: string;

  /**
   * 账户类型
   * @default "apaas"
   */
  accountType?: AccountType;

  /**
   * 显示的用户名
   */
  label: string;

  /**
   * 头像 URL
   */
  avatarUrl?: string;

  /**
   * 尺寸
   * @default "medium"
   */
  size?: ComboboxSize;

  /**
   * 是否禁用
   */
  disabled?: boolean;

  /**
   * 最大文本长度
   */
  maxTextLength?: number;

  /**
   * 后缀（如关闭按钮）
   */
  suffix?: React.ReactNode;

  /**
   * 自定义样式
   */
  className?: string;

  /**
   * 是否启用点击头像弹出 UserProfile
   * @default true
   */
  enableProfile?: boolean;

  avatarFallback?: boolean;
};

export const UserPill: React.FC<UserPillProps> = ({
  userId,
  accountType = 'apaas',
  label,
  avatarUrl,
  size = 'medium',
  disabled,
  maxTextLength,
  suffix,
  className,
  enableProfile = true,
  avatarFallback,
}) => {
  const baseAvatarElement = renderPillAvatar({
    avatarUrl,
    label,
    size,
    avatarFallback,
  });

  const avatarWithPopover = React.useMemo(() => {
    if (!enableProfile) {
      return baseAvatarElement;
    }

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
    };

    return (
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn('cursor-pointer rounded-full')}
            onClick={handleClick}
          >
            {baseAvatarElement}
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="bottom"
          align="start"
          sideOffset={8}
          onOpenAutoFocus={handleProfileOpenAutoFocus}
          className="w-80 p-0"
        >
          <UserProfile userId={userId} accountType={accountType} />
        </PopoverContent>
      </Popover>
    );
  }, [enableProfile, baseAvatarElement, userId, accountType]);

  return (
    <ItemPill
      label={label}
      avatar={avatarWithPopover}
      className={className}
      maxTextLength={maxTextLength}
      suffix={suffix}
      size={size}
      disabled={disabled}
      avatarFallback={avatarFallback}
    />
  );
};
