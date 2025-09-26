'use strict';

const Homey = require('homey');
const { OpenAI } = require('openai');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const STATUS_WAIT_RESPONE = 'Waiting for ChatGPT';
const STATUS_WAIT_QUEUE = 'Queued output not requested';
const STATUS_IDLE = 'Idle';
const INTERFACE = {
  COMPLETION: 1,
  CHAT: 2,
};
const LEGACY_COMPLETION_MAX_TOKENS = 200;
const LEGACY_CHAT_MAX_TOKENS = 200;
const DEFAULT_GPT5_MAX_COMPLETION_TOKENS = 2048;
const MIN_GPT5_MAX_COMPLETION_TOKENS = 1024;
const MAX_GPT5_MAX_COMPLETION_TOKENS = 8192;
const CHEAP_MODELS = [
  'gpt-5-nano',
  'gpt-5-mini',
  'gpt-4.1-mini',
  'gpt-4o-mini',
  'gpt-4.1-nano',
  'gpt-5',
  'gpt-5-chat-latest',
];
const DEFAULT_ENGINE = CHEAP_MODELS[0];
const GPT5_MODELS = new Set([
  'gpt-5',
  'gpt-5-mini',
  'gpt-5-nano',
  'gpt-5-chat-latest',
]);
const LEGACY_CHAT_MODELS = new Set([
  'gpt-4',
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4-32k',
  'gpt-4-turbo',
  'gpt-4-turbo-preview',
  'gpt-3.5-turbo',
]);
const COMPLETION_MODELS = new Set([
  'gpt-3.5-turbo-instruct',
]);
const HTTP_STATUS = {
  RATE_LIMIT: 429,
  BAD_REQUEST: 400,
};

class OpenAIApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.__status = STATUS_IDLE;
    this.__input = '';
    this.__output = '';
    this.log('OpenAIApp has been initialized');
    this.randomName = this.homey.settings.get('UserID');
    if (this.randomName === null) {
      this.log('First time running so creating unique UserID');
      this.randomName = `${Math.random()}-${Math.random()}-${Math.random()}-${Math.random()}`;
      this.homey.settings.set('UserID', this.randomName);
    }

    this.engine = this.homey.settings.get('engine');
    if (!CHEAP_MODELS.includes(this.engine)) {
      this.log('Using default low-cost engine for showcase');
      this.engine = DEFAULT_ENGINE;
      this.homey.settings.set('engine', this.engine);
    }
    this.interface = this.checkInterface(this.engine);

    this.imageEngine = this.homey.settings.get('imageEngine');
    if (this.imageEngine === null) {
      this.log('First time running so setting default imageEngine');
      this.imageEngine = 'dall-e-2';
      this.homey.settings.set('imageEngine', this.imageEngine);
    }

    this.imageQuality = this.homey.settings.get('imageQuality');
    if (this.imageQuality === null) {
      this.log('First time running so setting default imageQuality');
      this.imageQuality = 'standard';
      this.homey.settings.set('imageQuality', this.imageQuality);
    }

    this.maxWait = this.homey.settings.get('maxWait');
    if (this.maxWait === null) {
      this.log('First time running so setting default maxWait');
      this.maxWait = 60 * 5;
      this.homey.settings.set('maxWait', this.maxWait);
    }

    this.maxLength = this.homey.settings.get('maxLength');
    if (this.maxLength === null) {
      this.log('First time running so setting default maxLength');
      this.maxLength = 4000;
      this.homey.settings.set('maxLength', this.maxLength);
    }

    this.temperature = this.homey.settings.get('temperature');
    if (this.temperature === null) {
      this.log('First time running so setting default temperature');
      this.temperature = 0.6;
      this.homey.settings.set('temperature', this.temperature);
    }

    this.prefix = this.homey.settings.get('prefix');
    if (this.prefix === null) {
      this.log('First time running so setting default prefix');
      this.prefix = this.homey.__('settings.defaultPrefix');
      this.homey.settings.set('prefix', this.prefix);
    }

    this.split = this.homey.settings.get('split');
    if (this.split === null) {
      this.log('First time running so setting default split');
      this.split = 200;
      this.homey.settings.set('split', this.split);
    }

    this.gpt5MaxCompletionTokens = this._normalizeGpt5MaxTokens(
      this.homey.settings.get('gpt5MaxCompletionTokens'),
    );
    if (this.homey.settings.get('gpt5MaxCompletionTokens') !== this.gpt5MaxCompletionTokens) {
      this.homey.settings.set('gpt5MaxCompletionTokens', this.gpt5MaxCompletionTokens);
    }

    this.homey.settings.on('set', (setting) => {
      if (setting === 'APIKey') {
        delete this.openai;
        this.openai = new OpenAI({
          apiKey: this.homey.settings.get('APIKey'),
        });
      }
      const engine = this.homey.settings.get('engine');
      this.engine = CHEAP_MODELS.includes(engine) ? engine : DEFAULT_ENGINE;
      if (this.engine !== engine) {
        this.homey.settings.set('engine', this.engine);
      }
      this.imageEngine = this.homey.settings.get('imageEngine');
      this.imageQuality = this.homey.settings.get('imageQuality');
      this.interface = this.checkInterface(this.engine);
      this.maxWait = this.homey.settings.get('maxWait');
      this.maxLength = this.homey.settings.get('maxLength');
      this.temperature = this.homey.settings.get('temperature');
      this.prefix = this.homey.settings.get('prefix');
      this.split = this.homey.settings.get('split');
      this.gpt5MaxCompletionTokens = this._normalizeGpt5MaxTokens(
        this.homey.settings.get('gpt5MaxCompletionTokens'),
      );
      if (this.homey.settings.get('gpt5MaxCompletionTokens') !== this.gpt5MaxCompletionTokens) {
        this.homey.settings.set('gpt5MaxCompletionTokens', this.gpt5MaxCompletionTokens);
      }
    });

    this.prompt = this.prefix;
    this.chat = [{ role: 'system', content: this.prefix }];
    this.ongoing = false;
    this.prevTime = new Date();
    this.tokenQueue = [];
    this.canSendToken = true;

    this.openai = new OpenAI({
      apiKey: this.homey.settings.get('APIKey'),
    });

    // Simple flows flowcard
    const askQuestionActionSimple = this.homey.flow.getActionCard('ask-chatgpt-a-question-simple');
    askQuestionActionSimple.registerRunListener(async (args, state) => {
      await this.askQuestion(args.Question);
    });

    // Advanced flow flowcard
    const askQuestionActionAdvanced = this.homey.flow.getActionCard('ask-chatgpt-a-question-advanced');
    askQuestionActionAdvanced.registerRunListener(async (args, state) => this.askQuestion(args.Question));

    // Generate Image flowcard
    const generateImageAction = this.homey.flow.getActionCard('generate-an-image');
    generateImageAction.registerRunListener(async (args, state) => {
      this.log(`Generate image of size ${args.size} from text ${args.description}`);

      // Start Image generation:
      const size = Number.isFinite(+args.size) ? `${args.size}x${args.size}` : args.size;
      const imageParams = {
        model: this.imageEngine,
        prompt: args.description,
        n: 1,
        size,
        quality: this.imageQuality,
      };
      const response = await this.openai.images.generate(imageParams)
/*        .catch((err) => {
          this.log(`ERROR: ${err.status}`);
          if (err.status === HTTP_STATUS.RATE_LIMIT) {
            // Try again (only 1 image per 1 minute)
            return sleep(6000)
              .then(() => { this.log('igjen'); return this.openai.images.generate(imageParams); });
          }
          this.log('ugg');
          return Promise.reject(err);
        })*/;
      const imageUrl = response.data[0].url;
      this.log(`Got image: ${imageUrl}`);
      this.__image = imageUrl;

      const myImage = await this.homey.images.createImage();
      myImage.setUrl(imageUrl);

      return {
        DALLE_Image: myImage,
      };
    });

    // Start next partial answer
    const flushQueueAction = this.homey.flow.getActionCard('flush-queue');
    flushQueueAction.registerRunListener(async (args, state) => {
      this.canSendToken = true;
      return this.sendToken();
    });

    // Webhooks
    const webhookId = Homey.env.WEBHOOK_ID;
    const webhookSecret = Homey.env.WEBHOOK_SECRET;
    const homeyId = await this.homey.cloud.getHomeyId();
    const data = {
      // Provide unique properties for this Homey here
      deviceId: `${homeyId}`,
    };
    const webhook = `https://webhooks.athom.com/webhook/63c484ce5081010bae97f67e?homey=${homeyId}&message=something&flag=something`;
    console.log(`Webhook address: ${webhook}`);
    this.homey.settings.set('webhook', webhook);
    let retryCount = 10;
    while (retryCount > 0 && webhookId != null) {
      try {
        const myWebhook = await this.homey.cloud.createWebhook(webhookId, webhookSecret, data);

        myWebhook.on('message', (args) => {
          this.log('Got a webhook message!');
          this.log('headers:', args.headers);
          this.log('query:', args.query);

          let message = '';
          let body = '';
          try {
            // In case the mime header got corrupted homey think's it's json and messes up the message
            body = (typeof args.body === 'string') ? args.body : JSON.stringify(args.body).replaceAll('\\n', '\n');
            this.log(body);
            const list = body.split('\n');
            let subject = '';
            let breaksFound = 0;
            let plainTextPart = false;
            let isBase64 = false;
            for (let i = 0; i < list.length; i++) {
              if ((breaksFound === 0) && list[i].startsWith('Subject: ')) subject = list[i].substring(9);
              if (list[i].startsWith('Content-Type:')) {
                if (list[i].includes('text/plain')) {
                  plainTextPart = true;
                  message = '';
                  breaksFound = 0;
                } else {
                  plainTextPart = false;
                }
              }
              if (list[i].startsWith('Content-Transfer-Encoding:')) isBase64 = list[i].includes('base64');
              if (list[i].startsWith('--')) plainTextPart = false; // end of multipart block
              if (plainTextPart && breaksFound === 1) message += (isBase64 ? Buffer.from(list[i], 'base64').toString() : list[i]);
              breaksFound += list[i] === '';
            }
            this.log('subject:', subject);
          } catch (err) {
            this.log('==== ERROR ====\n', err);
          }
          if (!message) message = args.query.message;
          this.log('message:', message);
          if (message) {
            const flag = args.query.flag || '';
            this.log(`Flag: ${flag}`);
            const webhookToken = {
              flag,
              message,
            };
            const webhookTrigger = this.homey.flow.getTriggerCard('webhook-triggered');
            webhookTrigger.trigger(webhookToken);
          } else {
            this.log('body', body);
          }
        });
        retryCount = 0;
      } catch (err) {
        if (retryCount === 1) {
          throw new Error('Could not Initialize the webhook despite multiple attempts. Please restart the app');
        }
        retryCount--;
      }
    }
  }

  splitIntoSubstrings(str, maxLength) {
    const substrings = [];
    while (str.length > 0) {
      let substr = str.substring(0, maxLength);
      const lastSpaceIndex = (str.length <= maxLength) ? maxLength
        : substr.lastIndexOf(' ') + 1;
      if (lastSpaceIndex !== -1) {
        // If there is a space within the first maxLength characters, split the string at that space
        substr = substr.substring(0, lastSpaceIndex);
      }
      str = str.substring(substr.length);

      substr = substr.replace(/(\r\n|\n|\r)/gm, ' ');
      substrings.push(substr);
    }
    return substrings;
  }

  checkInterface() {
    if (COMPLETION_MODELS.has(this.engine)) {
      this.log(`Completion engine: ${this.engine}`);
      return INTERFACE.COMPLETION;
    }

    this.log(`Interface engine: ${this.engine}`);
    return INTERFACE.CHAT;
  }

  _normalizeGpt5MaxTokens(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return DEFAULT_GPT5_MAX_COMPLETION_TOKENS;
    }

    const clamped = Math.min(
      MAX_GPT5_MAX_COMPLETION_TOKENS,
      Math.max(MIN_GPT5_MAX_COMPLETION_TOKENS, Math.floor(parsed)),
    );
    return clamped;
  }

  extractResponseText(response) {
    if (!response) {
      return '';
    }

    if (typeof response.output_text === 'string' && response.output_text.trim()) {
      return response.output_text.trim();
    }

    if (Array.isArray(response.output)) {
      const parts = [];
      for (const block of response.output) {
        if (!block) continue;
        if (typeof block.text === 'string') {
          parts.push(block.text);
          continue;
        }
        if (Array.isArray(block.content)) {
          for (const contentItem of block.content) {
            if (contentItem && typeof contentItem.text === 'string') {
              parts.push(contentItem.text);
            }
          }
        }
      }
      if (parts.length) {
        return parts.join('');
      }
    }

    if (response.choices && response.choices[0]) {
      const choice = response.choices[0];
      if (choice && choice.message) {
        const content = choice.message.content;
        if (typeof content === 'string') {
          return content;
        }
        if (Array.isArray(content)) {
          return content.map((item) => {
            if (typeof item === 'string') return item;
            if (item && typeof item.text === 'string') return item.text;
            return '';
          }).join('');
        }
      }
      if (typeof choice.text === 'string') {
        return choice.text;
      }
    }

    return '';
  }

  logLargeObject(prefix, object) {
    try {
      const json = JSON.stringify(object);
      const chunkSize = 900;
      for (let idx = 0; idx < json.length; idx += chunkSize) {
        const chunk = json.substring(idx, idx + chunkSize);
        this.log(`${prefix}${idx === 0 ? '' : ` (chunk ${Math.floor(idx / chunkSize) + 1})`}: ${chunk}`);
      }
    } catch (err) {
      this.log(`${prefix}: [unserializable object: ${err}]`);
    }
  }

  async askQuestion(question) {
    if (this.ongoing) {
      throw new Error('Still working on previous request');
    }
    this.ongoing = true;
    let fullText = '';
    let pendingText = '';
    let lengthExceeded = false;
    let timeExceeded = false;
    const isGPT5Engine = GPT5_MODELS.has(this.engine);
    if (isGPT5Engine && +this.temperature !== 1) {
      this.log('GPT-5 engines only support default temperature; reverting to 1');
      this.temperature = 1;
      try {
        this.homey.settings.set('temperature', this.temperature);
      } catch (err) {
        this.log(`Unable to persist temperature override: ${err}`);
      }
    }
    const effectiveTemperature = isGPT5Engine ? 1 : +this.temperature;
    try {
      if (!(question.endsWith('.')
        || question.endsWith('?')
        || question.endsWith('!'))) {
        question += '.';
      }
      let now = new Date();
      if (now - this.prevTime > (1000 * 60 * 10)) {
        // Forget the conversation after 10 minutes
        this.log('Forgetting the conversation');
        this.prompt = this.prefix;
        this.chat = [{ role: 'system', content: this.prefix }];
        this.canSendToken = true;
        this.tokenQueue = [];
      }
      this.prevTime = now;
      this.prompt += ` ${question}`; // Add space because ChatGpt may have missed one.
      this.chat.push({ role: 'user', content: question });
      if (this.prompt.length > this.maxLength) {
        this.log(`Forgetting what was before ${this.maxLength} characters ago`);
        this.prompt = this.prompt.substr(-(this.maxLength - pendingText.length));
        while (JSON.stringify(this.chat).length > this.maxLength) {
          this.chat.shift();
        }
      }
      let finished = false;
      const startTime = new Date(now.getTime() - 1000 * 2);
      let nRequests = 1;
      while (!finished) {
        this.__status = STATUS_WAIT_RESPONE;
        this.__input = this.prompt + pendingText;
        let responseText;
        let completion;
        let finishReason = 'stop';
        if (this.interface === INTERFACE.COMPLETION) {
          const completionRequest = {
            model: this.engine,
            prompt: this.__input,
            user: this.randomName,
            temperature: effectiveTemperature,
          };
          completionRequest.max_tokens = LEGACY_COMPLETION_MAX_TOKENS;

          this.log(`Calling completions.create with model=${completionRequest.model}, temp=${completionRequest.temperature}, tokens=${completionRequest.max_tokens}, promptLength=${completionRequest.prompt?.length ?? 0}`);

          completion = await this.openai.completions.create(completionRequest);
          responseText = completion.choices[0].text;
          this.log(`Completions response finish_reason=${completion.choices[0].finish_reason}, textLength=${responseText?.length ?? 0}`);
          finishReason = completion.choices[0].finish_reason;
        } else { // this.interface === INTERFACE.CHAT
          const requestMessages = this.chat.map(({ role, content }) => {
            if (isGPT5Engine) {
              const text = (typeof content === 'string') ? content : JSON.stringify(content);
              return {
                role,
                content: [
                  {
                    type: 'text',
                    text,
                  },
                ],
              };
            }

            return { role, content };
          });
          const completionParams = {
            model: this.engine,
            messages: requestMessages,
            user: this.randomName,
            temperature: effectiveTemperature,
          };
          if (isGPT5Engine) {
            completionParams.max_completion_tokens = this.gpt5MaxCompletionTokens;
          } else {
            completionParams.max_tokens = LEGACY_CHAT_MAX_TOKENS;
          }

          this.log(`Calling chat.completions.create with model=${completionParams.model}, temp=${completionParams.temperature}, maxTokens=${completionParams.max_tokens ?? completionParams.max_completion_tokens}, messages=${completionParams.messages.length}`);

          try {
            const payloadPreview = JSON.stringify({
              model: completionParams.model,
              temperature: completionParams.temperature,
              max_tokens: completionParams.max_tokens,
              max_completion_tokens: completionParams.max_completion_tokens,
              messages: completionParams.messages.map((msg) => ({
                role: msg.role,
                content: Array.isArray(msg.content)
                  ? msg.content.map((part) => ({
                    type: part.type,
                    text: typeof part.text === 'string' ? part.text.slice(0, 200) : part.text,
                  }))
                  : (typeof msg.content === 'string' ? msg.content.slice(0, 200) : msg.content),
              })),
            });
            this.log(`chat.completions payload preview: ${payloadPreview}`);
          } catch (err) {
            this.log(`Unable to serialize chat.completions payload: ${err}`);
          }

          if (this.chat.length > 0) {
            const lastUserMessage = [...this.chat].reverse().find((msg) => msg.role === 'user');
            if (lastUserMessage) {
              this.log(`Last user message length=${lastUserMessage.content.length}`);
            }
          }

          completion = await this.openai.chat.completions.create(completionParams);
          const choice = completion.choices[0];
          if (choice?.message) {
            if (isGPT5Engine && Array.isArray(choice.message.content)) {
              responseText = choice.message.content
                .map((part) => {
                  if (typeof part === 'string') return part;
                  if (part && typeof part.text === 'string') return part.text;
                  return '';
                })
                .join('');
            } else if (typeof choice.message.content === 'string') {
              responseText = choice.message.content;
            }
          }
          if (!responseText && choice && typeof choice.text === 'string') {
            responseText = choice.text;
          }
          if (!responseText) {
            this.logLargeObject('Chat completion raw choice', choice);
          }
          if (!responseText) {
            if (isGPT5Engine) {
              throw new Error('GPT-5 returned no assistant content before hitting the token limit');
            }
          }
          const assistantText = responseText || '';
          if (assistantText) {
            const answerRole = choice?.message?.role || 'assistant';
            this.chat.push({ role: answerRole, content: assistantText });
          }
          this.log(`Chat completion finish_reason=${completion.choices[0].finish_reason}, contentLength=${responseText?.length ?? 0}`);
          finishReason = completion.choices[0].finish_reason;
        }

        now = new Date();
        const lapsedTime = (now - this.prevTime) / 1000;
        this.__output = responseText;
        const newText = this.__output.replace(/[\r\n]/gm, '');
        let response = pendingText + newText;
        lengthExceeded = (fullText.length + response.length) > this.maxLength;
        if (lengthExceeded) response += '. Aborted, length exceeded.';
        timeExceeded = lapsedTime > this.maxWait;
        if (timeExceeded) response += '. Aborted, time exceeded.';
        finished = (finishReason !== 'length')
          || lengthExceeded
          || timeExceeded;
        let splitPos = -1;
        const punctations = ['.', ',', ':', ';'];
        for (let idx = 0; idx < punctations.length; idx++) {
          const dot = punctations[idx];
          const lastDot = response.lastIndexOf(dot);
          if ((lastDot > splitPos) && (lastDot < this.split)) {
            splitPos = lastDot;
          }
        }
        if ((splitPos === -1) && (response.length >= +this.homey.settings.get('split'))) {
          splitPos = +this.homey.settings.get('split');
        }
        if (finished) {
          pendingText = '';
        } else if (splitPos === -1) {
          pendingText = response;
          response = '';
        } else {
          pendingText = response.substring(splitPos + 1);
          response = response.substring(0, splitPos + 1);
        }
        const splitText = this.splitIntoSubstrings(response, this.homey.settings.get('split'));
        for (let idx = 0; idx < splitText.length; idx++) {
          await this.sendToken(splitText[idx].replace(/^(\.|\?| )+/gm, ''));
          this.log(`Partial answer: ${splitText[idx]}`);
          this.prompt += splitText[idx];
          fullText += splitText[idx];
        }
        // Make sure we don't ask more than once per second:
        if (!finished) {
          nRequests++;
          const timeDiff = (now - startTime) / 1000;
          const rate = nRequests / timeDiff;
          if (rate > 0.6) {
            this.log('Query rate exceeded, waiting 1.5 secconds');
            await sleep(1500);
          }
        }
      }
      const completeToken = { ChatGPT_FullResponse: fullText };
      const completeTrigger = this.homey.flow.getTriggerCard('chatGPT-complete');
      this.log(`Full answer: ${fullText}`);
      // this.log(`Token: ${this.prompt} ||| ${pendingText}`);
      await completeTrigger.trigger(completeToken);
      if (timeExceeded) throw new Error('Time limit exceeded');
      if (lengthExceeded) throw new Error('Response length exceeded');
    } catch (err) {
      const errText = `${err}`;
      this.__output = errText;
      this.log('Query resulted in error:');
      this.log(`  engine:      ${this.engine}`);
      this.log(`  temperature: ${this.temperature}`);
      this.log(`  user:        ${this.randomName}`);
      this.log(`  prompt: ${this.prompt + pendingText}`);
      this.log('Error text: ');
      this.log(`  ${err}`);
      await this.sendToken(errText);
      const completeToken = { ChatGPT_FullResponse: errText };
      const completeTrigger = this.homey.flow.getTriggerCard('chatGPT-complete');
      await completeTrigger.trigger(completeToken);
      throw new Error(errText);
    } finally {
      this.ongoing = false;
    }
    return { ChatGPT_FullResponse: fullText };
  }

  async sendToken(token = undefined) {
    if (token !== undefined) {
      this.__status = STATUS_WAIT_QUEUE;
      this.tokenQueue.push(token);
    }
    if (this.tokenQueue.length === 0) {
      this.__status = STATUS_IDLE;
      return Promise.reject(new Error('There are no more partial answers'));
    }
    if (this.canSendToken) {
      this.canSendToken = false;
      const responseToken = { ChatGPT_Response: this.tokenQueue.shift() };
      const responseTrigger = this.homey.flow.getTriggerCard('chatGPT-answers');
      responseTrigger.trigger(responseToken);
    }
    return Promise.resolve();
  }

}

module.exports = OpenAIApp;
