// /* 模板代码 仅作示例 */
// import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
// import { toast } from 'sonner';
// import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
// import { getApiErrorMessage } from '@/lib/api-error';

// // 接口的请求 / 响应类型先写在 shared/api.interface.ts，再从 @shared/api.interface 导入
// interface RecordItem {
//   id: string;
//   title?: string;
//   type?: string;
//   creator?: string;
//   speakDate?: string;
// }

// interface RecordListParams {
//   limit?: number;
//   type?: string; // 筛选选「全部」时不传
// }

// // 读：useQuery，状态用返回的 isLoading / isError / error，不手写 loading/error state
// export function useRecordList(params: RecordListParams) {
//   return useQuery({
//     queryKey: ['records', params],
//     queryFn: () =>
//       axiosForBackend
//         .get<RecordItem[]>('/api/hello/test', { params })
//         .then((r) => r.data),
//   });
// }

// // 写：useMutation 必须 retry: false（避免重复提交），成功后刷新相关查询
// // method 和 path 必须与后端 controller 一致（此处假设后端有 POST /api/hello）
// export function useCreateRecord() {
//   const queryClient = useQueryClient();
//   return useMutation({
//     mutationFn: (body: Omit<RecordItem, 'id'>) =>
//       axiosForBackend.post<RecordItem>('/api/hello', body).then((r) => r.data),
//     retry: false,
//     onSuccess: () => queryClient.invalidateQueries({ queryKey: ['records'] }),
//     onError: (error) => toast.error(getApiErrorMessage(error, '保存失败，请稍后重试')),
//   });
// }