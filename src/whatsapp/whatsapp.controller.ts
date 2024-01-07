import { Body, Controller, Get, Logger, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { WhatsappService } from './whatsapp.service';

@Controller('whatsapp')
export class WhatsappController {
  private readonly logger = new Logger(WhatsappController.name);

  constructor(private whatsappService: WhatsappService) {}

  @Get('webhook')
  verifyWebhook(@Query() query: any) {
    const result = this.whatsappService.verifyWebhook(query);
    if (result.isVerified) {
      this.logger.log('WEBHOOK VERIFIED');
    } else {
      this.logger.log('WEBHOOK NOT VERIFIED');
    }
    return result.challenge;
  }

  @Post('webhook')
  async webhookPost(@Body() request: any, @Res({ passthrough: true }) response: Response) {
    const result = await this.whatsappService.handleWebhookPost(request);
    response.status(result.code).send(result.message);
  }
}
