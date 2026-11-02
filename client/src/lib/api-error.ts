/**
 * 从接口错误中取出给用户看的文案（catch、toast.error、页面错误态统一用它）。
 *
 * 后端异常结构：{ error: { code, message, fieldErrors?: { 字段: ['错误'] } } }，顶层没有 message。
 * 读取顺序：error.response.data.error.message → 第一条 fieldErrors 文案 → 调用方兜底文案。
 * 不读 axios 的 error.message（它是 "Request failed with status code 400" 这类英文）。
 */
interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    fieldErrors?: Record<string, string[] | undefined>;
  };
}

export function getApiErrorMessage(
  error: unknown,
  fallback = '操作失败，请稍后重试',
): string {
  if (typeof error !== 'object' || error === null) return fallback;
  const body = (error as { response?: { data?: ApiErrorBody } }).response?.data;
  const detail = body?.error;

  if (typeof detail?.message === 'string' && detail.message.trim()) {
    return detail.message;
  }

  for (const messages of Object.values(detail?.fieldErrors ?? {})) {
    const first = Array.isArray(messages)
      ? messages.find((m) => typeof m === 'string' && m.trim())
      : undefined;
    if (first) return first;
  }

  return fallback;
}
