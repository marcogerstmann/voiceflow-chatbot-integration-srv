import { Controller, Get, Post } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';

@Controller('whatsapp')
export class WhatsappController {
  constructor(private whatsappService: WhatsappService) {}

  @Get('webhook')
  webhookGet(req: any) {
    this.whatsappService.handleWebhookGet(req);
  }

  @Post('webhook')
  webhookPost(req: any) {
    this.whatsappService.handleWebhookPost(req);
  }
}
