// /* 模板代码 仅作示例 */
// import { Transform, Type } from 'class-transformer';
// import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
// import { RECORD_TYPES } from '@shared/api.interface';

// // 查询参数原始值都是字符串：数字字段加 @Type(() => Number)
// // 可选筛选字段：前端「全部」可能发出空串，读原始值 obj[key]，空串当未传
// export class HelloListQueryDto {
//   @IsOptional()
//   @Type(() => Number)
//   @IsInt()
//   @Min(1)
//   @Max(100)
//   limit?: number;

//   @IsOptional()
//   @Transform(({ obj, key, value }) => (obj[key] === '' ? undefined : value))
//   @IsString()
//   @IsIn(RECORD_TYPES)
//   type?: 'meeting' | 'memo';
// }
