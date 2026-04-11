import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// Mock env reader (used by the factory, not needed in unit tests)
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// --- Grammy mock ---

type Handler = (...args: any[]) => any;

// Global registry of all MockBot instances created during a test.
// `botRef.current` keeps backward compatibility with existing single-bot
// tests (it's the last-constructed bot). `botRef.byToken` lets multi-bot
// tests retrieve a specific bot by its constructor token.
const botRef = vi.hoisted(() => ({
  current: null as any,
  byToken: new Map<string, any>(),
}));

vi.mock('grammy', () => ({
  Bot: class MockBot {
    token: string;
    commandHandlers = new Map<string, Handler>();
    filterHandlers = new Map<string, Handler[]>();
    errorHandler: Handler | null = null;

    api = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
    };

    constructor(token: string) {
      this.token = token;
      botRef.current = this;
      botRef.byToken.set(token, this);
    }

    command(name: string, handler: Handler) {
      this.commandHandlers.set(name, handler);
    }

    on(filter: string, handler: Handler) {
      const existing = this.filterHandlers.get(filter) || [];
      existing.push(handler);
      this.filterHandlers.set(filter, existing);
    }

    catch(handler: Handler) {
      this.errorHandler = handler;
    }

    start(opts: { onStart: (botInfo: any) => void }) {
      opts.onStart({ username: 'andy_ai_bot', id: 12345 });
    }

    stop() {}
  },
}));

import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  TelegramChannel,
  TelegramChannelOpts,
  loadGroupBotMap,
} from './telegram.js';

// --- Constructor helper ---
//
// Unit 1 of the multi-bot Telegram plan (2026-04-11-002) changed the
// TelegramChannel constructor to take Maps instead of a single token.
// This helper preserves the single-bot test ergonomics while letting
// individual tests override tokens or the group→bot map when they need to
// exercise multi-bot routing.

function makeChannel(
  opts: TelegramChannelOpts,
  overrides?: {
    tokens?: Map<string, string>;
    groupBotMap?: Map<string, string>;
  },
): TelegramChannel {
  return new TelegramChannel(
    overrides?.tokens ?? new Map([['default', 'test-token']]),
    overrides?.groupBotMap ?? new Map(),
    opts,
  );
}

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<TelegramChannelOpts>,
): TelegramChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'tg:100200300': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function createTextCtx(overrides: {
  chatId?: number;
  chatType?: string;
  chatTitle?: string;
  text: string;
  fromId?: number;
  firstName?: string;
  username?: string;
  messageId?: number;
  date?: number;
  entities?: any[];
}) {
  const chatId = overrides.chatId ?? 100200300;
  const chatType = overrides.chatType ?? 'group';
  return {
    chat: {
      id: chatId,
      type: chatType,
      title: overrides.chatTitle ?? 'Test Group',
    },
    from: {
      id: overrides.fromId ?? 99001,
      first_name: overrides.firstName ?? 'Alice',
      username: overrides.username ?? 'alice_user',
    },
    message: {
      text: overrides.text,
      date: overrides.date ?? Math.floor(Date.now() / 1000),
      message_id: overrides.messageId ?? 1,
      entities: overrides.entities ?? [],
    },
    me: { username: 'andy_ai_bot' },
    reply: vi.fn(),
  };
}

function createMediaCtx(overrides: {
  chatId?: number;
  chatType?: string;
  fromId?: number;
  firstName?: string;
  date?: number;
  messageId?: number;
  caption?: string;
  extra?: Record<string, any>;
}) {
  const chatId = overrides.chatId ?? 100200300;
  return {
    chat: {
      id: chatId,
      type: overrides.chatType ?? 'group',
      title: 'Test Group',
    },
    from: {
      id: overrides.fromId ?? 99001,
      first_name: overrides.firstName ?? 'Alice',
      username: 'alice_user',
    },
    message: {
      date: overrides.date ?? Math.floor(Date.now() / 1000),
      message_id: overrides.messageId ?? 1,
      caption: overrides.caption,
      ...(overrides.extra || {}),
    },
    me: { username: 'andy_ai_bot' },
  };
}

function currentBot() {
  return botRef.current;
}

async function triggerTextMessage(ctx: ReturnType<typeof createTextCtx>) {
  const handlers = currentBot().filterHandlers.get('message:text') || [];
  for (const h of handlers) await h(ctx);
}

async function triggerMediaMessage(
  filter: string,
  ctx: ReturnType<typeof createMediaCtx>,
) {
  const handlers = currentBot().filterHandlers.get(filter) || [];
  for (const h of handlers) await h(ctx);
}

// --- Tests ---

describe('TelegramChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    botRef.byToken.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when bot starts', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('registers command and message handlers on connect', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);

      await channel.connect();

      expect(currentBot().commandHandlers.has('chatid')).toBe(true);
      expect(currentBot().commandHandlers.has('ping')).toBe(true);
      expect(currentBot().filterHandlers.has('message:text')).toBe(true);
      expect(currentBot().filterHandlers.has('message:photo')).toBe(true);
      expect(currentBot().filterHandlers.has('message:video')).toBe(true);
      expect(currentBot().filterHandlers.has('message:voice')).toBe(true);
      expect(currentBot().filterHandlers.has('message:audio')).toBe(true);
      expect(currentBot().filterHandlers.has('message:document')).toBe(true);
      expect(currentBot().filterHandlers.has('message:sticker')).toBe(true);
      expect(currentBot().filterHandlers.has('message:location')).toBe(true);
      expect(currentBot().filterHandlers.has('message:contact')).toBe(true);
    });

    it('registers error handler on connect', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);

      await channel.connect();

      expect(currentBot().errorHandler).not.toBeNull();
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);

      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Text message handling ---

  describe('text message handling', () => {
    it('delivers message for registered group', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hello everyone' });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:100200300',
        expect.any(String),
        'Test Group',
        'telegram',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          id: '1',
          chat_jid: 'tg:100200300',
          sender: '99001',
          sender_name: 'Alice',
          content: 'Hello everyone',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      const ctx = createTextCtx({ chatId: 999999, text: 'Unknown chat' });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:999999',
        expect.any(String),
        'Test Group',
        'telegram',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips command messages (starting with /)', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      const ctx = createTextCtx({ text: '/start' });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('extracts sender name from first_name', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hi', firstName: 'Bob' });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ sender_name: 'Bob' }),
      );
    });

    it('falls back to username when first_name missing', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hi' });
      ctx.from.first_name = undefined as any;
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ sender_name: 'alice_user' }),
      );
    });

    it('falls back to user ID when name and username missing', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hi', fromId: 42 });
      ctx.from.first_name = undefined as any;
      ctx.from.username = undefined as any;
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ sender_name: '42' }),
      );
    });

    it('uses sender name as chat name for private chats', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'tg:100200300': {
            name: 'Private',
            folder: 'private',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = makeChannel(opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Hello',
        chatType: 'private',
        firstName: 'Alice',
      });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:100200300',
        expect.any(String),
        'Alice', // Private chats use sender name
        'telegram',
        false,
      );
    });

    it('uses chat title as name for group chats', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Hello',
        chatType: 'supergroup',
        chatTitle: 'Project Team',
      });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:100200300',
        expect.any(String),
        'Project Team',
        'telegram',
        true,
      );
    });

    it('converts message.date to ISO timestamp', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      const unixTime = 1704067200; // 2024-01-01T00:00:00.000Z
      const ctx = createTextCtx({ text: 'Hello', date: unixTime });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          timestamp: '2024-01-01T00:00:00.000Z',
        }),
      );
    });
  });

  // --- @mention translation ---

  describe('@mention translation', () => {
    it('translates @bot_username mention to trigger format', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: '@andy_ai_bot what time is it?',
        entities: [{ type: 'mention', offset: 0, length: 12 }],
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@Andy @andy_ai_bot what time is it?',
        }),
      );
    });

    it('does not translate if message already matches trigger', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: '@Andy @andy_ai_bot hello',
        entities: [{ type: 'mention', offset: 6, length: 12 }],
      });
      await triggerTextMessage(ctx);

      // Should NOT double-prepend — already starts with @Andy
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@Andy @andy_ai_bot hello',
        }),
      );
    });

    it('does not translate mentions of other bots', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: '@some_other_bot hi',
        entities: [{ type: 'mention', offset: 0, length: 15 }],
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@some_other_bot hi', // No translation
        }),
      );
    });

    it('handles mention in middle of message', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'hey @andy_ai_bot check this',
        entities: [{ type: 'mention', offset: 4, length: 12 }],
      });
      await triggerTextMessage(ctx);

      // Bot is mentioned, message doesn't match trigger → prepend trigger
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@Andy hey @andy_ai_bot check this',
        }),
      );
    });

    it('handles message with no entities', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'plain message' });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: 'plain message',
        }),
      );
    });

    it('ignores non-mention entities', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'check https://example.com',
        entities: [{ type: 'url', offset: 6, length: 19 }],
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: 'check https://example.com',
        }),
      );
    });
  });

  // --- Non-text messages ---

  describe('non-text messages', () => {
    it('stores photo with placeholder', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:photo', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Photo]' }),
      );
    });

    it('stores photo with caption', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      const ctx = createMediaCtx({ caption: 'Look at this' });
      await triggerMediaMessage('message:photo', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Photo] Look at this' }),
      );
    });

    it('stores video with placeholder', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:video', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Video]' }),
      );
    });

    it('stores voice message with placeholder', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:voice', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Voice message]' }),
      );
    });

    it('stores audio with placeholder', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:audio', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Audio]' }),
      );
    });

    it('stores document with filename', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      const ctx = createMediaCtx({
        extra: { document: { file_name: 'report.pdf' } },
      });
      await triggerMediaMessage('message:document', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Document: report.pdf]' }),
      );
    });

    it('stores document with fallback name when filename missing', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      const ctx = createMediaCtx({ extra: { document: {} } });
      await triggerMediaMessage('message:document', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Document: file]' }),
      );
    });

    it('stores sticker with emoji', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      const ctx = createMediaCtx({
        extra: { sticker: { emoji: '😂' } },
      });
      await triggerMediaMessage('message:sticker', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Sticker 😂]' }),
      );
    });

    it('stores location with placeholder', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:location', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Location]' }),
      );
    });

    it('stores contact with placeholder', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:contact', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Contact]' }),
      );
    });

    it('ignores non-text messages from unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      const ctx = createMediaCtx({ chatId: 999999 });
      await triggerMediaMessage('message:photo', ctx);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends message via bot API', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      await channel.sendMessage('tg:100200300', 'Hello');

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '100200300',
        'Hello',
        { parse_mode: 'Markdown' },
      );
    });

    it('strips tg: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      await channel.sendMessage('tg:-1001234567890', 'Group message');

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '-1001234567890',
        'Group message',
        { parse_mode: 'Markdown' },
      );
    });

    it('splits messages exceeding 4096 characters', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      const longText = 'x'.repeat(5000);
      await channel.sendMessage('tg:100200300', longText);

      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(2);
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        1,
        '100200300',
        'x'.repeat(4096),
        { parse_mode: 'Markdown' },
      );
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        2,
        '100200300',
        'x'.repeat(904),
        { parse_mode: 'Markdown' },
      );
    });

    it('sends exactly one message at 4096 characters', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      const exactText = 'y'.repeat(4096);
      await channel.sendMessage('tg:100200300', exactText);

      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('handles send failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      currentBot().api.sendMessage.mockRejectedValueOnce(
        new Error('Network error'),
      );

      // Should not throw
      await expect(
        channel.sendMessage('tg:100200300', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('does nothing when bot is not initialized', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);

      // Don't connect — bot is null
      await channel.sendMessage('tg:100200300', 'No bot');

      // No error, no API call
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns tg: JIDs', () => {
      const channel = makeChannel(createTestOpts());
      expect(channel.ownsJid('tg:123456')).toBe(true);
    });

    it('owns tg: JIDs with negative IDs (groups)', () => {
      const channel = makeChannel(createTestOpts());
      expect(channel.ownsJid('tg:-1001234567890')).toBe(true);
    });

    it('does not own WhatsApp group JIDs', () => {
      const channel = makeChannel(createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own WhatsApp DM JIDs', () => {
      const channel = makeChannel(createTestOpts());
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = makeChannel(createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('sends typing action when isTyping is true', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      await channel.setTyping('tg:100200300', true);

      expect(currentBot().api.sendChatAction).toHaveBeenCalledWith(
        '100200300',
        'typing',
      );
    });

    it('does nothing when isTyping is false', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      await channel.setTyping('tg:100200300', false);

      expect(currentBot().api.sendChatAction).not.toHaveBeenCalled();
    });

    it('does nothing when bot is not initialized', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);

      // Don't connect
      await channel.setTyping('tg:100200300', true);

      // No error, no API call
    });

    it('handles typing indicator failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      currentBot().api.sendChatAction.mockRejectedValueOnce(
        new Error('Rate limited'),
      );

      await expect(
        channel.setTyping('tg:100200300', true),
      ).resolves.toBeUndefined();
    });
  });

  // --- Bot commands ---

  describe('bot commands', () => {
    it('/chatid replies with chat ID and metadata', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('chatid')!;
      const ctx = {
        chat: { id: 100200300, type: 'group' as const },
        from: { first_name: 'Alice' },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('tg:100200300'),
        expect.objectContaining({ parse_mode: 'Markdown' }),
      );
    });

    it('/chatid shows chat type', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('chatid')!;
      const ctx = {
        chat: { id: 555, type: 'private' as const },
        from: { first_name: 'Bob' },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('private'),
        expect.any(Object),
      );
    });

    it('/ping replies with bot status', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('ping')!;
      const ctx = { reply: vi.fn() };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith('Andy is online.');
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "telegram"', () => {
      const channel = makeChannel(createTestOpts());
      expect(channel.name).toBe('telegram');
    });
  });

  // --- Multi-bot constructor (plan 2026-04-11-002 Unit 1) ---

  describe('multi-bot constructor', () => {
    it('accepts a single default bot token (backward-compat shape)', () => {
      const channel = new TelegramChannel(
        new Map([['default', 'test-token']]),
        new Map(),
        createTestOpts(),
      );
      expect(channel.name).toBe('telegram');
      expect(channel.isConnected()).toBe(false);
    });

    it('accepts multiple bot tokens plus a group→bot assignment map', () => {
      const channel = new TelegramChannel(
        new Map([
          ['default', 'default-token'],
          ['wiki_tutor', 'wiki-tutor-token'],
        ]),
        new Map([['wiki-tutor', 'wiki_tutor']]),
        createTestOpts(),
      );
      expect(channel.name).toBe('telegram');
    });
  });

  // --- Multi-bot routing (plan 2026-04-11-002 Unit 2) ---
  //
  // These tests build a channel with two bots (`default` and `wiki_tutor`)
  // and verify that inbound messages are delivered through exactly one bot
  // per group and outbound messages go out through the group's assigned bot.

  describe('multi-bot routing', () => {
    // Two registered groups:
    //  - tg:100200300 / folder "test-group"  → default bot (no entry in map)
    //  - tg:555666777 / folder "wiki-tutor"  → wiki_tutor bot
    const twoGroupOpts = () =>
      createTestOpts({
        registeredGroups: vi.fn(() => ({
          'tg:100200300': {
            name: 'Default Group',
            folder: 'test-group',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
          'tg:555666777': {
            name: 'Wiki Tutor',
            folder: 'wiki-tutor',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });

    const makeTwoBotChannel = (opts: TelegramChannelOpts) =>
      new TelegramChannel(
        new Map([
          ['default', 'default-token'],
          ['wiki_tutor', 'wiki-tutor-token'],
        ]),
        new Map([['wiki-tutor', 'wiki_tutor']]),
        opts,
      );

    const handlersFor = (token: string, filter: string): Handler[] => {
      const bot = botRef.byToken.get(token);
      if (!bot) throw new Error(`No bot for token ${token}`);
      return bot.filterHandlers.get(filter) || [];
    };

    const fireText = async (
      token: string,
      ctx: ReturnType<typeof createTextCtx>,
    ) => {
      for (const h of handlersFor(token, 'message:text')) await h(ctx);
    };

    it('starts one Bot per token and reports connected', async () => {
      const channel = makeTwoBotChannel(twoGroupOpts());
      await channel.connect();

      expect(botRef.byToken.size).toBe(2);
      expect(botRef.byToken.has('default-token')).toBe(true);
      expect(botRef.byToken.has('wiki-tutor-token')).toBe(true);
      expect(channel.isConnected()).toBe(true);
    });

    it('delivers message to wiki-tutor group via the wiki_tutor bot', async () => {
      const opts = twoGroupOpts();
      const channel = makeTwoBotChannel(opts);
      await channel.connect();

      const ctx = createTextCtx({
        chatId: 555666777,
        text: 'what is the wiki about?',
      });
      await fireText('wiki-tutor-token', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:555666777',
        expect.objectContaining({ content: 'what is the wiki about?' }),
      );
    });

    it('drops messages for wiki-tutor group arriving on the default bot', async () => {
      const opts = twoGroupOpts();
      const channel = makeTwoBotChannel(opts);
      await channel.connect();

      const ctx = createTextCtx({
        chatId: 555666777,
        text: 'should be ignored by default bot',
      });
      await fireText('default-token', ctx);

      // onChatMetadata still fires — chat discovery is global.
      expect(opts.onChatMetadata).toHaveBeenCalled();
      // But onMessage must NOT fire — the default bot is not this group's owner.
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('delivers message to default-routed group via the default bot', async () => {
      const opts = twoGroupOpts();
      const channel = makeTwoBotChannel(opts);
      await channel.connect();

      const ctx = createTextCtx({
        chatId: 100200300,
        text: 'hello from default group',
      });
      await fireText('default-token', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: 'hello from default group' }),
      );
    });

    it('drops messages for default-routed group arriving on the wiki_tutor bot', async () => {
      const opts = twoGroupOpts();
      const channel = makeTwoBotChannel(opts);
      await channel.connect();

      const ctx = createTextCtx({
        chatId: 100200300,
        text: 'wiki_tutor should ignore the default group',
      });
      await fireText('wiki-tutor-token', ctx);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('routes exactly one delivery when both bots see the same message', async () => {
      // This is the double-delivery regression test. Both bots are members
      // of the wiki-tutor chat (possible during a persona transition), both
      // receive the inbound message, and only the owning bot should deliver.
      const opts = twoGroupOpts();
      const channel = makeTwoBotChannel(opts);
      await channel.connect();

      const ctx1 = createTextCtx({
        chatId: 555666777,
        text: 'same message, seen by both bots',
        messageId: 42,
      });
      const ctx2 = createTextCtx({
        chatId: 555666777,
        text: 'same message, seen by both bots',
        messageId: 42,
      });
      await fireText('default-token', ctx1);
      await fireText('wiki-tutor-token', ctx2);

      expect(opts.onMessage).toHaveBeenCalledTimes(1);
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:555666777',
        expect.objectContaining({ content: 'same message, seen by both bots' }),
      );
    });

    it('sends outbound to wiki-tutor group via the wiki_tutor bot', async () => {
      const opts = twoGroupOpts();
      const channel = makeTwoBotChannel(opts);
      await channel.connect();

      await channel.sendMessage('tg:555666777', 'librarian reply');

      const wikiTutorBot = botRef.byToken.get('wiki-tutor-token');
      const defaultBot = botRef.byToken.get('default-token');
      expect(wikiTutorBot.api.sendMessage).toHaveBeenCalledWith(
        '555666777',
        'librarian reply',
        { parse_mode: 'Markdown' },
      );
      expect(defaultBot.api.sendMessage).not.toHaveBeenCalled();
    });

    it('sends outbound to default-routed group via the default bot', async () => {
      const opts = twoGroupOpts();
      const channel = makeTwoBotChannel(opts);
      await channel.connect();

      await channel.sendMessage('tg:100200300', 'default reply');

      const defaultBot = botRef.byToken.get('default-token');
      const wikiTutorBot = botRef.byToken.get('wiki-tutor-token');
      expect(defaultBot.api.sendMessage).toHaveBeenCalledWith(
        '100200300',
        'default reply',
        { parse_mode: 'Markdown' },
      );
      expect(wikiTutorBot.api.sendMessage).not.toHaveBeenCalled();
    });

    it('sends to unregistered chat via default bot (no group lookup match)', async () => {
      const opts = twoGroupOpts();
      const channel = makeTwoBotChannel(opts);
      await channel.connect();

      await channel.sendMessage('tg:999999', 'no group, use default');

      const defaultBot = botRef.byToken.get('default-token');
      expect(defaultBot.api.sendMessage).toHaveBeenCalledWith(
        '999999',
        'no group, use default',
        { parse_mode: 'Markdown' },
      );
    });

    it('routes setTyping to the assigned bot for each group', async () => {
      const opts = twoGroupOpts();
      const channel = makeTwoBotChannel(opts);
      await channel.connect();

      await channel.setTyping('tg:555666777', true);
      await channel.setTyping('tg:100200300', true);

      const wikiTutorBot = botRef.byToken.get('wiki-tutor-token');
      const defaultBot = botRef.byToken.get('default-token');
      expect(wikiTutorBot.api.sendChatAction).toHaveBeenCalledWith(
        '555666777',
        'typing',
      );
      expect(defaultBot.api.sendChatAction).toHaveBeenCalledWith(
        '100200300',
        'typing',
      );
    });

    it('falls back to default bot when group is assigned to an orphan bot ID', async () => {
      // groupBotMap references "experimental" but no such token exists.
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'tg:100200300': {
            name: 'Orphan',
            folder: 'orphan-group',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new TelegramChannel(
        new Map([['default', 'default-token']]),
        new Map([['orphan-group', 'experimental']]),
        opts,
      );
      await channel.connect();

      await channel.sendMessage('tg:100200300', 'orphan fallback');

      const defaultBot = botRef.byToken.get('default-token');
      expect(defaultBot.api.sendMessage).toHaveBeenCalledWith(
        '100200300',
        'orphan fallback',
        { parse_mode: 'Markdown' },
      );
    });

    it('disconnect stops every bot and reports not connected', async () => {
      const channel = makeTwoBotChannel(twoGroupOpts());
      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });
});

// --- Multi-bot config loader (plan 2026-04-11-002 Unit 1) ---
//
// loadGroupBotMap() reads ~/.config/nanoclaw/telegram-bots.json via
// fs.readFileSync. These tests redirect HOME to a temp directory and write
// fixture files there, so they exercise the real parse + validate path
// without touching the user's actual config.

describe('loadGroupBotMap', () => {
  let tempHome: string;
  let originalHomedir: typeof os.homedir;
  const configDir = () => path.join(tempHome, '.config', 'nanoclaw');
  const configFile = () => path.join(configDir(), 'telegram-bots.json');

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-test-'));
    originalHomedir = os.homedir;
    (os as any).homedir = () => tempHome;
  });

  afterEach(() => {
    (os as any).homedir = originalHomedir;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('returns an empty map when the config file is missing', () => {
    const map = loadGroupBotMap();
    expect(map.size).toBe(0);
  });

  it('parses a happy-path file with one group→bot entry', () => {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(
      configFile(),
      JSON.stringify({ 'wiki-tutor': 'wiki_tutor' }),
    );

    const map = loadGroupBotMap();
    expect(map.size).toBe(1);
    expect(map.get('wiki-tutor')).toBe('wiki_tutor');
  });

  it('treats an empty object as no assignments', () => {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(configFile(), '{}');

    const map = loadGroupBotMap();
    expect(map.size).toBe(0);
  });

  it('ignores malformed JSON and returns an empty map', () => {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(configFile(), '{not valid json');

    const map = loadGroupBotMap();
    expect(map.size).toBe(0);
  });

  it('ignores a JSON array (must be an object) and returns an empty map', () => {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(configFile(), '["wiki-tutor", "wiki_tutor"]');

    const map = loadGroupBotMap();
    expect(map.size).toBe(0);
  });

  it('skips non-string values but keeps valid sibling entries', () => {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(
      configFile(),
      JSON.stringify({
        'wiki-tutor': 'wiki_tutor',
        'broken-group': 42,
        'empty-group': '',
      }),
    );

    const map = loadGroupBotMap();
    expect(map.size).toBe(1);
    expect(map.get('wiki-tutor')).toBe('wiki_tutor');
    expect(map.has('broken-group')).toBe(false);
    expect(map.has('empty-group')).toBe(false);
  });

  it('handles multiple group assignments', () => {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(
      configFile(),
      JSON.stringify({
        'wiki-tutor': 'wiki_tutor',
        'experimental-group': 'experimental',
      }),
    );

    const map = loadGroupBotMap();
    expect(map.size).toBe(2);
    expect(map.get('wiki-tutor')).toBe('wiki_tutor');
    expect(map.get('experimental-group')).toBe('experimental');
  });
});
