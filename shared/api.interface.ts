/* 前后端共享的类型写在这里 */

// 固定取值（状态、类型等）在这里定义一次，前后端都从这里导入，不另写取值数组或守卫：
// export const RECORD_TYPES = ['meeting', 'memo'] as const;
// export type RecordType = (typeof RECORD_TYPES)[number];
// export const isRecordType = (v: string): v is RecordType =>
//   (RECORD_TYPES as readonly string[]).includes(v);
// export const RECORD_TYPE_LABELS: Record<RecordType, string> = { meeting: '会议', memo: '备忘' };
