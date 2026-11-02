import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import type {
  ConfirmGroupRequest,
  ConfirmGroupResult,
  MeegoPendingDraft,
} from '@shared/api.interface';

export async function getMeegoPending(pendingId: string): Promise<MeegoPendingDraft> {
  const response = await axiosForBackend({
    url: `/api/meego-bridge/pending/${pendingId}`,
    method: 'GET',
  });
  return response.data as MeegoPendingDraft;
}

export async function confirmMeegoGroup(
  body: ConfirmGroupRequest,
): Promise<ConfirmGroupResult> {
  const response = await axiosForBackend({
    url: '/api/meego-bridge/confirm',
    method: 'POST',
    data: body,
  });
  return response.data as ConfirmGroupResult;
}
