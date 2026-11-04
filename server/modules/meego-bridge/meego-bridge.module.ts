import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { MeegoBridgeController } from './meego-bridge.controller';
import { MeegoBridgeService } from './meego-bridge.service';
import { FeishuApiService } from './feishu-api.service';
import { MeegoBridgeAutomationService } from './meego-bridge.automation';

@Module({
  imports: [HttpModule],
  controllers: [MeegoBridgeController],
  providers: [FeishuApiService, MeegoBridgeService, MeegoBridgeAutomationService],
  exports: [FeishuApiService], // 供 isgm-notification 等其他场景模块复用
})
export class MeegoBridgeModule {}
