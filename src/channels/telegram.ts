import fs from 'fs';
import os from 'os';
import path from 'path';

import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile, readEnvFilePrefix } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

/**
 * Sentinel bot ID for the default bot — the one loaded from TELEGRAM_BOT_TOKEN.
 * Every code path that means "the default bot" references this constant so a
 * typo can't silently drop messages into a missing Map slot.
 */
const DEFAULT_BOT_ID = 'default';

/**
 * Compute the path to the group-folder → bot-ID assignment file.
 * Lives outside the repo (so upstream merges never touch it) and outside
 * any container mount (so agents can't tamper with it). Follows the same
 * convention as ~/.config/nanoclaw/mount-allowlist.json.
 *
 * Resolved per-call rather than captured at module-load time so tests can
 * monkey-patch `os.homedir()` without re-importing the module.
 */
function botMapConfigPath(): string {
  return path.join(os.homedir(), '.config', 'nanoclaw', 'telegram-bots.json');
}

/**
 * Load the group-folder → bot-ID map from ~/.config/nanoclaw/telegram-bots.json.
 * Missing file, empty object, and malformed JSON all collapse to an empty
 * map — no group is routed to a non-default bot in those cases.
 *
 * @internal exported for tests only; factory is the sole production caller.
 */
export function loadGroupBotMap(): Map<string, string> {
  const configPath = botMapConfigPath();
  let content: string;
  try {
    content = fs.readFileSync(configPath, 'utf-8');
  } catch {
    logger.debug(
      { path: configPath },
      'Telegram: no telegram-bots.json found, all groups route to default bot',
    );
    return new Map();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    logger.warn(
      { err, path: configPath },
      'Telegram: telegram-bots.json is not valid JSON, ignoring (all groups route to default bot)',
    );
    return new Map();
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logger.warn(
      { path: configPath },
      'Telegram: telegram-bots.json must be a JSON object mapping group folder to bot ID, ignoring',
    );
    return new Map();
  }

  const map = new Map<string, string>();
  for (const [folder, botId] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (typeof botId !== 'string' || !botId) {
      logger.warn(
        { folder, botId, path: configPath },
        'Telegram: telegram-bots.json entry is not a non-empty string, skipping',
      );
      continue;
    }
    map.set(folder, botId);
  }

  return map;
}

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private opts: TelegramChannelOpts;
  // Map of bot ID → bot token. Always contains at least one entry with the
  // sentinel key DEFAULT_BOT_ID. Additional entries come from
  // TELEGRAM_BOT_TOKEN_<ID> env vars discovered at factory time.
  private tokens: Map<string, string>;
  // Group folder → bot ID assignment. Groups absent from this map route to
  // the default bot. Loaded from ~/.config/nanoclaw/telegram-bots.json.
  private groupBotMap: Map<string, string>;
  // Live Bot instances, populated in connect(). Keyed by the same bot IDs
  // as `tokens`. Filter inbound and dispatch outbound through this map.
  private bots: Map<string, Bot> = new Map();

  constructor(
    tokens: Map<string, string>,
    groupBotMap: Map<string, string>,
    opts: TelegramChannelOpts,
  ) {
    this.tokens = tokens;
    this.groupBotMap = groupBotMap;
    this.opts = opts;
  }

  /**
   * Resolve the bot ID that owns a given chat JID.
   * Looks up the registered group for the JID, reads the group's folder,
   * and returns the assigned bot ID from `groupBotMap`. Falls back to the
   * default bot if the group is unregistered, missing from the map, or
   * the map has no entry for its folder.
   */
  private resolveBotIdForJid(jid: string): string {
    const group = this.opts.registeredGroups()[jid];
    if (!group) return DEFAULT_BOT_ID;
    return this.groupBotMap.get(group.folder) ?? DEFAULT_BOT_ID;
  }

  /**
   * Look up a Bot by ID, falling back to the default bot if the requested
   * ID has no live instance (e.g., orphan entry in telegram-bots.json).
   * Returns null only if even the default bot isn't connected.
   */
  private botForId(botId: string): Bot | null {
    const bot = this.bots.get(botId);
    if (bot) return bot;
    const fallback = this.bots.get(DEFAULT_BOT_ID);
    if (fallback && botId !== DEFAULT_BOT_ID) {
      logger.warn(
        { requestedBotId: botId },
        'Telegram: requested bot has no live instance, falling back to default bot',
      );
    }
    return fallback ?? null;
  }

  /**
   * Attach command handlers, message handlers, and the error handler to a
   * single Bot instance. Called once per bot in `connect()`. The `botId`
   * closure parameter lets every inbound handler filter out messages
   * that belong to a different bot (see the expectedBotId check below).
   */
  private registerHandlers(bot: Bot, botId: string): void {
    // Command to get chat ID (useful for registration)
    bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery (always — helps discover new chats
      // regardless of which bot received the message).
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Multi-bot filter: if this chat is assigned to a different bot via
      // telegram-bots.json, the current bot must ignore it. The other bot
      // (if present in the chat) handles delivery. Must come BEFORE any
      // onMessage call so two bots in one chat never double-deliver.
      const expectedBotId =
        this.groupBotMap.get(group.folder) ?? DEFAULT_BOT_ID;
      if (expectedBotId !== botId) {
        logger.debug(
          { chatJid, groupFolder: group.folder, botId, expectedBotId },
          'Telegram: ignoring message on non-owning bot',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName, botId },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      // Same multi-bot filter as text handler — drop non-text messages
      // when this bot isn't the group's assigned owner.
      const expectedBotId =
        this.groupBotMap.get(group.folder) ?? DEFAULT_BOT_ID;
      if (expectedBotId !== botId) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    bot.on('message:photo', (ctx) => storeNonText(ctx, '[Photo]'));
    bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
    bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    bot.catch((err) => {
      logger.error({ botId, err: err.message }, 'Telegram bot error');
    });
  }

  /**
   * Start one Bot per loaded token. Each bot gets its own handler closures
   * capturing its own botId. If a bot fails to start, it's removed from
   * the live map but the remaining bots continue serving their groups.
   * connect() rejects only when every bot fails to start.
   */
  async connect(): Promise<void> {
    const entries = [...this.tokens.entries()];
    const startPromises = entries.map(
      ([botId, token]) =>
        new Promise<void>((resolve, reject) => {
          const bot = new Bot(token);
          this.registerHandlers(bot, botId);
          this.bots.set(botId, bot);

          let started = false;
          const startCall = bot.start({
            onStart: (botInfo) => {
              started = true;
              logger.info(
                { botId, username: botInfo.username, id: botInfo.id },
                'Telegram bot connected',
              );
              console.log(`\n  Telegram bot (${botId}): @${botInfo.username}`);
              console.log(
                `  Send /chatid to the bot to get a chat's registration ID\n`,
              );
              resolve();
            },
          });
          // grammy's Bot.start() returns a Promise that rejects on init
          // failure. The mock in tests returns undefined — both shapes are
          // handled here so tests and production share the same code path.
          if (
            startCall &&
            typeof (startCall as unknown as Promise<void>).catch === 'function'
          ) {
            (startCall as unknown as Promise<void>).catch((err) => {
              if (!started) {
                logger.error(
                  { botId, err: err?.message ?? String(err) },
                  'Telegram bot failed to start',
                );
                this.bots.delete(botId);
                reject(err);
              }
            });
          }
        }),
    );

    const results = await Promise.allSettled(startPromises);
    const started = results.filter((r) => r.status === 'fulfilled').length;
    if (started === 0) {
      throw new Error('Telegram: all bots failed to start');
    }
    if (started < entries.length) {
      logger.warn(
        { started, total: entries.length },
        'Telegram: some bots failed to start — continuing with working bots',
      );
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (this.bots.size === 0) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    const botId = this.resolveBotIdForJid(jid);
    const bot = this.botForId(botId);
    if (!bot) {
      logger.warn(
        { jid, botId },
        'Telegram: no bot available to send message (not even default)',
      );
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(bot.api, numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info({ jid, length: text.length, botId }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, botId, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bots.size > 0;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bots.size === 0) return;
    for (const [botId, bot] of this.bots) {
      try {
        bot.stop();
      } catch (err) {
        logger.warn(
          { botId, err },
          'Telegram: bot.stop() threw during disconnect',
        );
      }
    }
    this.bots.clear();
    logger.info('Telegram bots stopped');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (this.bots.size === 0 || !isTyping) return;
    const botId = this.resolveBotIdForJid(jid);
    const bot = this.botForId(botId);
    if (!bot) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  // Default bot token — the existing single-bot contract.
  // Preserves "process.env first, .env fallback" semantics for dev vs launchd.
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const defaultToken =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';

  // Additional named bots: TELEGRAM_BOT_TOKEN_<ID> from both process.env
  // (dev) and the .env file (launchd). Suffix is lowercased so the bot ID
  // written in telegram-bots.json stays in normal casing while env keys
  // follow shell UPPER_SNAKE convention.
  const tokens = new Map<string, string>();
  if (defaultToken) tokens.set(DEFAULT_BOT_ID, defaultToken);

  const addNamedToken = (rawSuffix: string, value: string) => {
    if (!rawSuffix || !value) return;
    const botId = rawSuffix.toLowerCase();
    if (botId === DEFAULT_BOT_ID) {
      logger.warn(
        { envKey: `TELEGRAM_BOT_TOKEN_${rawSuffix}` },
        'Telegram: named bot ID collides with sentinel "default", ignoring',
      );
      return;
    }
    tokens.set(botId, value);
  };

  // Scan process.env for named tokens (dev path — `npm run dev`).
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('TELEGRAM_BOT_TOKEN_') || !v) continue;
    addNamedToken(k.slice('TELEGRAM_BOT_TOKEN_'.length), v);
  }

  // Scan the .env file for named tokens (production path — launchd).
  const envFilePrefixed = readEnvFilePrefix('TELEGRAM_BOT_TOKEN_');
  for (const [suffix, value] of Object.entries(envFilePrefixed)) {
    // process.env wins if both are set, matching the default-token pattern above.
    const botId = suffix.toLowerCase();
    if (tokens.has(botId)) continue;
    addNamedToken(suffix, value);
  }

  if (tokens.size === 0) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }

  // Load the group-folder → bot-ID assignment map.
  const groupBotMap = loadGroupBotMap();

  // Validate: every bot ID referenced in groupBotMap must exist in tokens.
  // Orphan references are logged loudly but left in place — the lookup path
  // falls back to the default bot so the group stays functional.
  for (const [folder, botId] of groupBotMap) {
    if (!tokens.has(botId)) {
      logger.error(
        { folder, botId },
        'Telegram: telegram-bots.json references unknown bot ID (no matching TELEGRAM_BOT_TOKEN_<ID> env var). This group will fall back to the default bot.',
      );
    }
  }

  logger.info(
    {
      botCount: tokens.size,
      botIds: [...tokens.keys()],
      assignedGroups: [...groupBotMap.entries()].map(
        ([folder, botId]) => `${folder}→${botId}`,
      ),
    },
    'Telegram: loaded bot tokens and group assignment map',
  );

  return new TelegramChannel(tokens, groupBotMap, opts);
});
