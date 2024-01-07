import { Body, Controller, Get, Logger, Post, Query } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';

@Controller('whatsapp')
export class WhatsappController {
  private readonly logger = new Logger(WhatsappController.name);

  constructor(private whatsappService: WhatsappService) {}

  @Get('webhook')
  verifyWebhook(@Query() query: any) {
    console.log('the request', query);
    const result = this.whatsappService.verifyWebhook(query);
    if (result.isVerified) {
      this.logger.log('WEBHOOK VERIFIED');
    } else {
      this.logger.log('WEBHOOK NOT VERIFIED');
    }
    return result.challenge;
  }

  @Post('webhook')
  webhookPost(@Body() req: any) {
    // this.whatsappService.handleWebhookPost(req);
  }
}
