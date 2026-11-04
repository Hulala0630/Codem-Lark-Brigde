import { Module } from '@nestjs/common';
import { MeegoBridgeModule } from '../meego-bridge/meego-bridge.module';
import { IsgmNotificationController } from './isgm-notification.controller';
import { IsgmNotificationService } from './isgm-notification.service';
import { RiskParserService } from './risk-parser.service';
import { IsgmNotificationAutomationService } from './isgm-notification.automation';

@Module({
  imports: [MeegoBridgeModule], // 复用 FeishuApiService（飞书 OpenAPI 客户端）
  controllers: [IsgmNotificationController],
  providers: [IsgmNotificationService, RiskParserService, IsgmNotificationAutomationService],
})
export class IsgmNotificationModule {}
