import { env } from './env.js';

/**
 * Sending a Telegram message without Telegraf.
 *
 * The Telegram Bot API is just HTTPS: POST to
 * https://api.telegram.org/bot<TOKEN>/<method> with a JSON body. Telegraf is a
 * convenience layer over exactly this (see LEARNINGS §11). The worker only
 * ever SENDS, so pulling in a whole bot framework to make one HTTP call would
 * be the tail wagging the dog.
 *
 * Why this doesn't clash with the bot process using the same token: only
 * RECEIVING conflicts — Telegram allows one active getUpdates poller per token.
 * Any number of processes can call sendMessage.
 */

export interface InlineButton {
  text: string;
  callback_data: string;
}

/** Thrown when retrying cannot possibly help, so the job should NOT be retried. */
export class TelegramPermanentError extends Error {}

/**
 * Done / Skip buttons for a specific goal ON a specific day.
 *
 * Including the date in the payload matters: a follow-up can arrive after
 * midnight, and "Done" must record the day the reminder was FOR, not whatever
 * day it happens to be when the button is pressed. Telegraf in the bot process
 * parses this back out — the bot handles presses on messages the worker sent.
 *
 * Size check against Telegram's 64-byte callback_data limit:
 * "coach:skipped:" (14) + 24-char ObjectId + ":" + "YYYY-MM-DD" (11) = 49. Fits.
 */
export function checkInButtons(goalId: string, date: string): InlineButton[][] {
  return [
    [
      { text: '✅ Done', callback_data: `coach:done:${goalId}:${date}` },
      { text: '⏭️ Skip', callback_data: `coach:skipped:${goalId}:${date}` },
    ],
  ];
}

export async function sendTelegramMessage(
  chatId: string,
  text: string,
  buttons?: InlineButton[][],
): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${env.telegramBotToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
    }),
  });

  if (res.ok) return;

  const body = (await res.json().catch(() => null)) as { description?: string } | null;
  const reason = body?.description ?? `HTTP ${res.status}`;

  // 403 = the user blocked the bot or deleted the chat. Retrying three times
  // with backoff would just fail three times. Signal "don't bother".
  if (res.status === 403) throw new TelegramPermanentError(reason);

  // Anything else (429 rate limit, 5xx, network) is plausibly transient —
  // a plain throw lets BullMQ's retry-with-backoff take another run at it.
  throw new Error(`Telegram sendMessage failed: ${reason}`);
}
