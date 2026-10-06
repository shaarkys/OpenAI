'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const { Writable } = require('node:stream');

class MockHomeyBase {}

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'homey') {
    return { App: MockHomeyBase, Driver: MockHomeyBase, Device: MockHomeyBase };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const OpenAIApp = require('../app');
const ChatBotDriver = require('../drivers/chatbot/driver');
const CompletionBotDriver = require('../drivers/completionbot/driver');
const CompletionBot = require('../drivers/completionbot/device');

Module._load = originalLoad;

const completed = (outputText) => ({ status: 'completed', output_text: outputText });

test('showcase sends GPT-6 Luna text through Responses and keeps Flow output', async () => {
  const app = new OpenAIApp();
  let sent;
  app.openai = {
    responses: {
      create: async (request) => {
        sent = request;
        return completed('A short answer.');
      },
    },
  };
  app.engine = 'gpt-6-luna';
  app.interface = 2;
  app.gpt5MaxCompletionTokens = 2048;
  app.randomName = '0.12345678901234567-0.12345678901234567-0.12345678901234567-0.12345678901234567';
  app.temperature = 0.6;
  app.maxLength = 4000;
  app.maxWait = 300;
  app.split = 200;
  app.prefix = 'Answer concisely.';
  app.prompt = app.prefix;
  app.chat = [{ role: 'system', content: app.prefix }];
  app.prevTime = new Date();
  app.log = () => {};
  app.sendToken = async () => {};
  app.homey = {
    settings: { get: () => 200 },
    flow: { getTriggerCard: () => ({ trigger: async () => {} }) },
  };

  const result = await app.askQuestion('Hello');
  assert.equal(result.ChatGPT_FullResponse, 'A short answer.');
  assert.equal(sent.model, 'gpt-6-luna');
  assert.deepEqual(sent.reasoning, { effort: 'none' });
  assert.equal(sent.store, false);
  assert.equal(sent.input[1].content, 'Hello.');
  assert.equal(sent.temperature, undefined);
  assert.match(sent.safety_identifier, /^[a-f0-9]{64}$/);
  assert.equal(sent.safety_identifier, app.getSafetyIdentifier());
});

test('ChatBot preserves JSON mode and reports incomplete Responses output', async () => {
  const driver = new ChatBotDriver();
  let sent;
  driver.homey = { app: { extractResponseText: (response) => response.output_text } };
  driver.getOpenAI = () => ({
    responses: {
      create: async (request) => {
        sent = request;
        return completed('{"ok":true}');
      },
    },
  });
  driver.error = () => {};
  const settings = { model: 'gpt-6.1-sol', max_tokens: 2000, response_format: 'json_object' };
  const message = await driver.sendChatRequest([{ role: 'user', content: 'Return JSON' }], settings);
  assert.deepEqual(message, { role: 'assistant', content: '{"ok":true}' });
  assert.deepEqual(sent.text, { format: { type: 'json_object' } });
  assert.deepEqual(sent.reasoning, { effort: 'medium' });
  driver.getOpenAI = () => ({
    responses: {
      create: async () => ({
        status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: '',
      }),
    },
  });
  await assert.rejects(driver.sendChatRequest([], settings), /max_output_tokens/);
});

test('ChatBot keeps GPT-5.6 Luna on its existing Chat Completions path', async () => {
  const driver = new ChatBotDriver();
  let sent;
  driver.getOpenAI = () => ({
    chat: {
      completions: {
        create: async (request) => {
          sent = request;
          return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Existing answer.' } }] };
        },
      },
    },
  });
  driver.error = () => {};
  const message = await driver.sendChatRequest([{ role: 'user', content: 'Hi' }], {
    model: 'gpt-5.6-luna', max_tokens: 2000, response_format: 'text',
  });
  assert.equal(message.content, 'Existing answer.');
  assert.equal(sent.reasoning_effort, 'none');
  assert.equal(sent.max_completion_tokens, 2000);
});

test('CompletionBot migrates a retired setting and keeps its Flow token contract', async () => {
  const device = new CompletionBot();
  let migration;
  device.getSetting = () => 'babbage';
  device.setSettings = async (settings) => {
    migration = settings;
  };
  device.log = () => {};
  await device.onInit();
  assert.deepEqual(migration, { model: 'gpt-6-luna' });

  const driver = new CompletionBotDriver();
  let sent;
  driver.homey = { app: { extractResponseText: (response) => response.output_text } };
  driver.getOpenAI = () => ({
    responses: {
      create: async (request) => {
        sent = request;
        return completed('Completed.');
      },
    },
  });
  driver.warn = () => {};
  const result = await driver.sendCompletionRequest('Prompt', { model: 'babbage', max_tokens: 100 });
  assert.deepEqual(result, { completion: 'Completed.' });
  assert.equal(sent.model, 'gpt-6-luna');
  assert.equal(sent.input, 'Prompt');
});

test('image Flow preserves its token and converts legacy size to supported GPT Image output', async () => {
  const app = new OpenAIApp();
  let sent;
  let source;
  const bytes = Buffer.from('jpeg-bytes');
  app.imageEngine = 'gpt-image-2.5-flare';
  app.imageQuality = 'medium';
  app.log = () => {};
  app.openai = {
    images: {
      generate: async (request) => {
        sent = request;
        return { data: [{ b64_json: bytes.toString('base64') }] };
      },
    },
  };
  app.homey = {
    images: {
      createImage: async () => ({
        setStream: (callback) => {
          source = callback;
        },
      }),
    },
  };
  const result = await app.generateImage({ size: '256', description: 'Test image' });
  assert.ok(result.DALLE_Image);
  assert.equal(sent.size, '1024x1024');
  assert.equal(sent.output_format, 'jpeg');
  const chunks = [];
  const stream = new Writable({
    write: (chunk, encoding, done) => {
      chunks.push(chunk); done();
    },
  });
  source(stream);
  assert.deepEqual(Buffer.concat(chunks), bytes);

  app.openai.images.generate = async () => ({ data: [{ b64_json: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') }] });
  await assert.rejects(app.generateImage({ size: '1024', description: 'Too large' }), /5 MB limit/);
});
