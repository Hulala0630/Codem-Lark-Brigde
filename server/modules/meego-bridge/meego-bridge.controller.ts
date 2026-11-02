import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import { MeegoBridgeService } from './meego-bridge.service';
import { ConfirmGroupDto } from './meego-bridge.dto';

@Controller('api/meego-bridge')
@NeedLogin()
export class MeegoBridgeController {
  constructor(private readonly meegoBridgeService: MeegoBridgeService) {}

  /** 确认页读取草稿（Meego 事件信息、变更字段、模式） */
  @Get('pending/:id')
  async getPending(@Param('id') id: string) {
    return this.meegoBridgeService.getPending(id);
  }

  /** 确认执行：建群或更新群 */
  @Post('confirm')
  async confirm(@Body() dto: ConfirmGroupDto) {
    return this.meegoBridgeService.confirmPending(dto);
  }
}
