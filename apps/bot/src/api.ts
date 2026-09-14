import type { ApiError } from '@coach/shared';
import { env } from './env.js';

/**
 * The bot's client for our own API. Note what it does NOT do: talk to Mongo.
 *
 * The bot is a client of the same REST API the dashboard uses — it has no
 * database access of its own. That's the payoff of the kickoff decision to
 * build a separate Express API instead of Next.js route handlers: business
 * logic like "one check-in per goal per day" lives in exactly one place, and
 * both clients inherit it for free.
 */

export class ApiRequestError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/** Thrown when the API says this chat id has no account attached yet. */
export class NotLinkedError extends ApiRequestError {
  constructor() {
    super('Telegram account not linked', 403);
    this.name = 'NotLinkedError';
  }
}

async function request<T>(path: string, chatId: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${env.apiUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      // The two halves of the bot's identity claim: the secret proves "I am
      // the bot process", the chat id says "acting on behalf of this person".
      // The chat id is trustworthy because Telegram sets it, not the user.
      'X-Bot-Secret': env.botServiceSecret,
      'X-Telegram-Chat-Id': chatId,
      ...options.headers,
    },
  });

  if (res.status === 403) throw new NotLinkedError();

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiError | null;
    throw new ApiRequestError(body?.error ?? `Request failed (${res.status})`, res.status);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string, chatId: string) => request<T>(path, chatId),

  put: <T>(path: string, chatId: string, body: unknown) =>
    request<T>(path, chatId, { method: 'PUT', body: JSON.stringify(body) }),

  /**
   * Linking is the one call that CAN'T carry a chat id as identity — it's the
   * call that establishes that mapping in the first place. So it posts the
   * chat id as data rather than as a credential.
   */
  link: async (code: string, chatId: string) => {
    const res = await fetch(`${env.apiUrl}/telegram/link`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bot-Secret': env.botServiceSecret,
      },
      body: JSON.stringify({ code, chatId }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as ApiError | null;
      throw new ApiRequestError(body?.error ?? 'Linking failed', res.status);
    }
    return res.json();
  },
};
