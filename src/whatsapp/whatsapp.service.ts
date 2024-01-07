import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  private session = '';
  private noreplyTimeout = null;

  constructor(
    private configService: ConfigService,
    private httpService: HttpService,
  ) {}

  /**
   * Accepts GET requests at the /webhook endpoint. You need this URL to setup webhook initially.
   * Info on verification request payload: https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verification-requests
   * @param query
   */
  verifyWebhook(query: any): { isVerified: boolean; challenge: string } {
    const result = { isVerified: false, challenge: '' };
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];

    if (mode && token) {
      if (mode === 'subscribe' && token === this.configService.get<string>('VERIFY_TOKEN')) {
        result.isVerified = true;
        result.challenge = challenge;
      }
    }

    return result;
  }

  /**
   * Check the Incoming webhook message
   * Info on WhatsApp text message payload: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples#text-messages
   * @param request
   */
  async handleWebhookPost(request: any): Promise<{ code: number; message: string }> {
    if (request.object) {
      const isNotInteractive = request.entry[0]?.changes[0]?.value?.messages?.length || null;
      if (isNotInteractive) {
        const phoneNumberId = request.entry[0].changes[0].value.metadata.phone_number_id;
        const userId = request.entry[0].changes[0].value.messages[0].from; // extract the phone number from the webhook payload
        const userName = request.entry[0].changes[0].value.contacts[0].profile.name;
        if (request.entry[0].changes[0].value.messages[0].text) {
          await this.interact(
            userId,
            {
              type: 'text',
              payload: request.entry[0].changes[0].value.messages[0].text.body,
            },
            phoneNumberId,
            userName,
          );
        } else if (request.entry[0]?.changes[0]?.value?.messages[0]?.audio) {
          // TODO: Handle audio messages?
          // if (
          //   request.entry[0]?.changes[0]?.value?.messages[0]?.audio?.voice == true &&
          //   PICOVOICE_API_KEY
          // ) {
          //   let mediaURL = await this.httpService.axiosRef({
          //     method: 'GET',
          //     url: `https://graph.facebook.com/${WHATSAPP_VERSION}/${request.entry[0].changes[0].value.messages[0].audio.id}`,
          //     headers: {
          //       'Content-Type': 'application/json',
          //       Authorization: 'Bearer ' + WHATSAPP_TOKEN,
          //     },
          //   });
          //   const rndFileName = 'audio_' + Math.random().toString(36).substring(7) + '.ogg';
          //   this.httpService.axiosRef({
          //     method: 'get',
          //     url: mediaURL.data.url,
          //     headers: {
          //       Authorization: 'Bearer ' + WHATSAPP_TOKEN,
          //     },
          //     responseType: 'stream',
          //   }).then(function (response) {
          //     let engineInstance = new Leopard(PICOVOICE_API_KEY);
          //     const wstream = fs.createWriteStream(rndFileName);
          //     response.data.pipe(wstream);
          //     wstream.on('finish', async () => {
          //       this.logger.log('Analysing Audio file');
          //       const { transcript, words } = engineInstance.processFile(rndFileName);
          //       engineInstance.release();
          //       fs.unlinkSync(rndFileName);
          //       if (transcript && transcript != '') {
          //         this.logger.log('User audio:', transcript);
          //         await interact(
          //           userId,
          //           {
          //             type: 'text',
          //             payload: transcript,
          //           },
          //           phoneNumberId,
          //           userName,
          //         );
          //       }
          //     });
          //   });
          // }
        } else {
          if (
            request.entry[0].changes[0].value.messages[0].interactive.button_reply.id.includes(
              'path-',
            )
          ) {
            await this.interact(
              userId,
              {
                type: request.entry[0].changes[0].value.messages[0].interactive.button_reply.id,
                payload: {
                  label:
                    request.entry[0].changes[0].value.messages[0].interactive.button_reply.title,
                },
              },
              phoneNumberId,
              userName,
            );
          } else {
            await this.interact(
              userId,
              {
                type: 'intent',
                payload: {
                  query:
                    request.entry[0].changes[0].value.messages[0].interactive.button_reply.title,
                  intent: {
                    name: request.entry[0].changes[0].value.messages[0].interactive.button_reply.id,
                  },
                  entities: [],
                },
              },
              phoneNumberId,
              userName,
            );
          }
        }
      }
      return { code: 200, message: 'ok' };
    } else {
      // Return a '404 Not Found' if event is not from a WhatsApp API
      return { code: 404, message: 'error | unexpected body' };
    }
  }

  private async interact(userId, request, phoneNumberId, userName) {
    clearTimeout(this.noreplyTimeout);

    const voiceflowVersionId = this.configService.get<string>('VF_VERSION_ID');
    const voiceflowDmUrl = this.configService.get<string>('VF_DM_URL');
    const voiceflowApiKey = this.configService.get<string>('VF_API_KEY');

    if (!this.session) {
      this.session = `${voiceflowVersionId}.${this.createRandomId()}`;
    }

    await this.httpService.axiosRef({
      method: 'PATCH',
      url: `${voiceflowDmUrl}/state/user/${encodeURI(userId)}/variables`,
      headers: {
        Authorization: voiceflowApiKey,
        'Content-Type': 'application/json',
      },
      data: {
        user_id: userId,
        user_name: userName,
      },
    });

    const response = await this.httpService.axiosRef({
      method: 'POST',
      url: `${voiceflowDmUrl}/state/user/${encodeURI(userId)}/interact`,
      headers: {
        Authorization: voiceflowApiKey,
        'Content-Type': 'application/json',
        versionID: voiceflowVersionId,
        sessionID: this.session,
      },
      data: {
        action: request,
        config: {
          tts: false,
          stripSSML: true,
        },
      },
    });

    let isEnding = response.data.filter(({ type }) => type === 'end');
    if (isEnding.length > 0) {
      this.logger.log('isEnding');
      isEnding = true;
      this.saveTranscript(userName);
    } else {
      isEnding = false;
    }

    const messages = [];

    for (let i = 0; i < response.data.length; i++) {
      if (response.data[i].type == 'text') {
        let tmpspeech = '';

        for (let j = 0; j < response.data[i].payload.slate.content.length; j++) {
          for (let k = 0; k < response.data[i].payload.slate.content[j].children.length; k++) {
            if (response.data[i].payload.slate.content[j].children[k].type) {
              if (response.data[i].payload.slate.content[j].children[k].type == 'link') {
                tmpspeech += response.data[i].payload.slate.content[j].children[k].url;
              }
            } else if (
              response.data[i].payload.slate.content[j].children[k].text != '' &&
              response.data[i].payload.slate.content[j].children[k].fontWeight
            ) {
              tmpspeech += '*' + response.data[i].payload.slate.content[j].children[k].text + '*';
            } else if (
              response.data[i].payload.slate.content[j].children[k].text != '' &&
              response.data[i].payload.slate.content[j].children[k].italic
            ) {
              tmpspeech += '_' + response.data[i].payload.slate.content[j].children[k].text + '_';
            } else if (
              response.data[i].payload.slate.content[j].children[k].text != '' &&
              response.data[i].payload.slate.content[j].children[k].underline
            ) {
              tmpspeech +=
                // no underline in WhatsApp
                response.data[i].payload.slate.content[j].children[k].text;
            } else if (
              response.data[i].payload.slate.content[j].children[k].text != '' &&
              response.data[i].payload.slate.content[j].children[k].strikeThrough
            ) {
              tmpspeech += '~' + response.data[i].payload.slate.content[j].children[k].text + '~';
            } else if (response.data[i].payload.slate.content[j].children[k].text != '') {
              tmpspeech += response.data[i].payload.slate.content[j].children[k].text;
            }
          }
          tmpspeech += '\n';
        }
        if (response.data[i + 1]?.type && response.data[i + 1]?.type == 'choice') {
          messages.push({
            type: 'body',
            value: tmpspeech,
          });
        } else {
          messages.push({
            type: 'text',
            value: tmpspeech,
          });
        }
      } else if (response.data[i].type == 'speak') {
        if (response.data[i].payload.type == 'audio') {
          messages.push({
            type: 'audio',
            value: response.data[i].payload.src,
          });
        } else {
          if (response.data[i + 1]?.type && response.data[i + 1]?.type == 'choice') {
            messages.push({
              type: 'body',
              value: response.data[i].payload.message,
            });
          } else {
            messages.push({
              type: 'text',
              value: response.data[i].payload.message,
            });
          }
        }
      } else if (response.data[i].type == 'visual') {
        messages.push({
          type: 'image',
          value: response.data[i].payload.image,
        });
      } else if (response.data[i].type == 'choice') {
        let buttons = [];
        for (let b = 0; b < response.data[i].payload.buttons.length; b++) {
          let link = null;
          if (
            response.data[i].payload.buttons[b].request.payload.actions != undefined &&
            response.data[i].payload.buttons[b].request.payload.actions.length > 0
          ) {
            link = response.data[i].payload.buttons[b].request.payload.actions[0].payload.url;
          }
          if (link) {
            // Ignore links
          } else if (response.data[i].payload.buttons[b].request.type.includes('path-')) {
            buttons.push({
              type: 'reply',
              reply: {
                id: response.data[i].payload.buttons[b].request.type,
                title:
                  this.truncateString(response.data[i].payload.buttons[b].request.payload.label) ??
                  '',
              },
            });
          } else {
            buttons.push({
              type: 'reply',
              reply: {
                id: response.data[i].payload.buttons[b].request.payload.intent.name,
                title:
                  this.truncateString(response.data[i].payload.buttons[b].request.payload.label) ??
                  '',
              },
            });
          }
        }
        if (buttons.length > 3) {
          buttons = buttons.slice(0, 3);
        }
        messages.push({
          type: 'buttons',
          buttons: buttons,
        });
      } else if (response.data[i].type == 'no-reply' && isEnding == false) {
        this.noreplyTimeout = setTimeout(
          () => {
            this.sendNoReply(userId, phoneNumberId, userName);
          },
          Number(response.data[i].payload.timeout) * 1000,
        );
      }
    }
    await this.sendMessage(messages, phoneNumberId, userId);
    if (isEnding == true) {
      this.session = null;
    }
  }

  private async sendMessage(messages, phoneNumberId, from) {
    const timeoutPerKB = 10; // Adjust as needed, 10 milliseconds per kilobyte
    for (let j = 0; j < messages.length; j++) {
      let data;
      let ignore = null;
      if (messages[j].type == 'image') {
        data = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: from,
          type: 'image',
          image: {
            link: messages[j].value,
          },
        };
      } else if (messages[j].type == 'audio') {
        data = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: from,
          type: 'audio',
          audio: {
            link: messages[j].value,
          },
        };
      } else if (messages[j].type == 'buttons') {
        data = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: from,
          type: 'interactive',
          interactive: {
            type: 'button',
            body: {
              text: messages[j - 1]?.value || 'Make your choice',
            },
            action: {
              buttons: messages[j].buttons,
            },
          },
        };
      } else if (messages[j].type == 'text') {
        data = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: from,
          type: 'text',
          text: {
            preview_url: true,
            body: messages[j].value,
          },
        };
      } else {
        ignore = true;
      }
      if (!ignore) {
        try {
          await this.httpService.axiosRef({
            method: 'POST',
            url: `https://graph.facebook.com/${this.configService.get<string>(
              'WHATSAPP_VERSION',
            )}/${phoneNumberId}/messages`,
            data: data,
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer ' + this.configService.get<string>('WHATSAPP_TOKEN'),
            },
          });

          if (messages[j].type === 'image') {
            try {
              const response = await this.httpService.axiosRef.head(messages[j].value);

              if (response.headers['content-length']) {
                const imageSizeKB = parseInt(response.headers['content-length']) / 1024;
                const timeout = imageSizeKB * timeoutPerKB;
                await new Promise(resolve => setTimeout(resolve, timeout));
              }
            } catch (error) {
              this.logger.error('Failed to fetch image size:', error);
              await new Promise(resolve => setTimeout(resolve, 5000));
            }
          }
        } catch (err) {
          this.logger.error(err);
        }
      }
    }
  }

  private async sendNoReply(userId, phoneNumberId, userName) {
    clearTimeout(this.noreplyTimeout);
    this.logger.log('Send no reply');
    await this.interact(
      userId,
      {
        type: 'no-reply',
      },
      phoneNumberId,
      userName,
    );
  }

  private createRandomId() {
    const randomNo = Math.floor(Math.random() * 1000 + 1);
    const timestamp = Date.now();
    const date = new Date();
    const weekday = new Array(7);
    weekday[0] = 'Sunday';
    weekday[1] = 'Monday';
    weekday[2] = 'Tuesday';
    weekday[3] = 'Wednesday';
    weekday[4] = 'Thursday';
    weekday[5] = 'Friday';
    weekday[6] = 'Saturday';
    const day = weekday[date.getDay()];
    return randomNo + day + timestamp;
  }

  private truncateString(str, maxLength = 20) {
    if (str) {
      if (str.length > maxLength) {
        return str.substring(0, maxLength - 1) + '…';
      }
      return str;
    }
    return '';
  }

  private async saveTranscript(username) {
    const voiceflowProjectId = this.configService.get<string>('VF_PROJECT_ID');
    const voiceflowVersionId = this.configService.get<string>('VF_VERSION_ID');
    const voiceflowTranscriptIcon = this.configService.get<string>('VF_TRANSCRIPT_ICON');

    if (voiceflowProjectId) {
      if (!username || username == '' || username == undefined) {
        username = 'Anonymous';
      }
      this.httpService
        .axiosRef({
          method: 'put',
          url: 'https://api.voiceflow.com/v2/transcripts',
          data: {
            browser: 'WhatsApp',
            device: 'desktop',
            os: 'server',
            sessionID: this.session,
            unread: true,
            versionID: voiceflowVersionId,
            projectID: voiceflowProjectId,
            user: {
              name: username,
              image: voiceflowTranscriptIcon,
            },
          },
          headers: {
            Authorization: this.configService.get<string>('VF_API_KEY'),
          },
        })
        .then(() => {
          this.logger.log('Transcript Saved!');
        })
        .catch(err => this.logger.error(err));
    }
    this.session = `${voiceflowVersionId}.${this.createRandomId()}`;
  }
}
