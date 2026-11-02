// /* 模板代码 仅作示例 */
// import { Controller, Get, Query, Req } from '@nestjs/common';
// import type { Request } from 'express';
// import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
// import { HelloService } from './hello.service';
// import { HelloListQueryDto } from './hello.dto';

// // 整个 controller 都需要登录：在类上写一次 @NeedLogin()
// @Controller('api/hello')
// @NeedLogin()
// export class HelloController {
//   constructor(private readonly helloService: HelloService) {}

//   // 列表 / 筛选接口：用 @Query() 绑定 DTO，不逐个 @Query('xxx') + parseInt
//   @Get('test')
//   async test(@Req() req: Request, @Query() query: HelloListQueryDto) {
//     const { userId } = req.userContext;
//     return this.helloService.test(userId, query.limit ?? 5, query.type);
//   }
// }
