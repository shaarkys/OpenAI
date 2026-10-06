'use strict';

const { Driver, Device } = require('homey');
const { randomUUID } = require('crypto');

/**
 * This is the driver for completion bot devices that communicate with
 * OpenAI APIs to add LLM driven text completion.
 */
class CompletionBotDriver extends Driver {
  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.homey.flow.getActionCard('prompt')
      .registerRunListener(async (args, state) => {
        const { prompt, device } = args;
        return this.requestCompletion(device, prompt);
      });

    this.log('CompletionBotDriver has been initialized');
  }

  /**
   * Generates a unique ID for each completionBot device.
  */
  _generateUniqueId() {
    return randomUUID();
  }

  /**
   * onPairListDevices is called when a user is adding a device
   * and the 'list_devices' view is called.
   * This should return list containing a completionBot device ready for pairing.
   * There can be any number of completionBot devices added to Homey.
   * Each device will have an id based on the conversation id for the chat.
   */
  async onPairListDevices() {
    return [
      {
        name: 'CompletionBot',
        data: {
          id: this._generateUniqueId(),
        },
      },
    ];
  }

 /**
   * Send a prompt for a text completion from OpenAI APIs.
   * @param {Device} completionBot 
   * @param {string} prompt 
   * @returns {{ completion: string }} The completion to the text in a completion token.
   */
  async requestCompletion(completionBot, prompt) {
    let settings = completionBot.getSettings();

    // handle timeout according to settings
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Request timed out')), settings.timeout)
    );

    let x =  await Promise.race([
      this.sendCompletionRequest(prompt, settings),
      timeoutPromise
    ]);

    return x;
  }

  /**
   * Send completion request to OpenAI APIs.
   * @param {string} prompt 
   * @param {*} settings 
   * @returns {{ completion: string }} The completion to the text in a completion token.
   */
  async sendCompletionRequest(prompt, settings) {
    const retiredModels = new Set(['gpt-3.5-turbo-instruct', 'davinci-002', 'babbage-002', 'babbage']);
    const model = retiredModels.has(settings.model) ? 'gpt-6-luna' : settings.model;
    if (model !== settings.model) {
      this.warn(`CompletionBot model ${settings.model} was retired; using ${model}`);
    }
    const effort = ['gpt-6-astra', 'gpt-6.1-sol'].includes(model) ? 'medium' : 'none';
    const response = await this.getOpenAI().responses.create({
      model,
      input: prompt,
      reasoning: { effort },
      max_output_tokens: +settings.max_tokens,
      store: false,
    });
    if (response.status === 'incomplete') {
      throw new Error(`OpenAI returned incomplete output: ${response.incomplete_details?.reason || 'unknown reason'}`);
    }
    const completion = this.homey.app.extractResponseText(response);
    if (response.status !== 'completed' || !completion) {
      throw new Error(`OpenAI returned ${response.status || 'no'} response without assistant text`);
    }
    return { completion };
  }

  /**
   * @returns {OpenAI} The OpenAI API instance.
   */
  getOpenAI() {
    return this.homey.app.openai;
  }
}

module.exports = CompletionBotDriver;
