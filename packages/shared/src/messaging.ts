/**
 * Inbound messaging channels: reach an Agent Nekko chat from a messaging app
 * (Telegram first; Slack and BYO-Twilio follow the same adapter shape).
 *
 * The trust model is deliberately narrower than the relay's paired devices: a
 * messaging channel is open only while it is enabled AND names the chats it
 * serves. An unlisted chat id gets a refusal, never a session, because a bot
 * token answering in the wrong room is a remote shell.
 */

/** One messaging channel's configuration (the `telegram` key on settings.messaging). */
export interface TelegramMessagingConfig {
  /** Master switch. Nothing polls or answers while off, even with a token set. */
  enabled?: boolean;
  /** Bot token from @BotFather. */
  botToken?: string;
  /**
   * Chat ids allowed to drive chats. An empty or missing list refuses every
   * inbound message: the allowlist is the whole authorization boundary, so it
   * is never implicit.
   */
  allowedChatIds?: string[];
}

/** `settings.messaging`: one config block per channel adapter. */
export interface MessagingSettings {
  telegram?: TelegramMessagingConfig;
}

/** Live per-channel state, for the Connectors card. */
export interface MessagingStatus {
  telegram?: {
    /** The poll loop is alive (token valid, enabled). */
    running: boolean;
    /** The bot's own username once getMe has answered. */
    botUsername?: string;
    lastError?: string;
    /** Chat ids currently bound to a session. */
    boundChats: number;
  };
}
