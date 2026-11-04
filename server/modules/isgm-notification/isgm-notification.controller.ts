import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import { IsgmNotificationService } from './isgm-notification.service';

@Controller('api/isgm')
@NeedLogin()
export class IsgmNotificationController {
  constructor(private readonly isgmService: IsgmNotificationService) {}

  /** 查询某周期的风险反馈状态 */
  @Get('status/:cycleKey')
  async getStatus(@Param('cycleKey') cycleKey: string) {
    return this.isgmService.getStatus(cycleKey);
  }

  /** 记录责任人反馈 */
  @Post('feedback')
  async feedback(@Body() dto: { cycleKey: string; ownerOpenId?: string; ownerName?: string; feedback: string }) {
    return this.isgmService.recordFeedback(dto);
  }

  /** 汇总（force 可强制未完成汇总） */
  @Post('summarize')
  async summarize(@Body() dto: { cycleKey: string; force?: boolean }) {
    return this.isgmService.summarize(dto.cycleKey, dto.force === true);
  }
}
