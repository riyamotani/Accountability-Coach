import { Telegraf, Markup, type Context } from 'telegraf';
import { formatTimeOfDay, type Goal, type CheckIn, type User, type CheckInStatus } from '@coach/shared';
import { env } from './env.js';
import { api, NotLinkedError, ApiRequestError } from './api.js';

const bot = new Telegraf(env.botToken);

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Today's date as "YYYY-MM-DD".
 *
 * KNOWN LIMITATION: this uses the BOT SERVER's local date, not the user's
 * timezone. For a user in the same zone as the server it's correct; for
 * anyone else it can be off by a day near midnight. The scheduler (see
 * apps/api/src/worker.ts) already resolves dates per-user via
 * `localDateInZone` — the bot doesn't yet, since it would first need to
 * fetch the user's stored timezone rather than just their chat id.
 */
function todayLocalDate(): string {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

// `| undefined` is required because tsconfig.base.json sets
// exactOptionalPropertyTypes: true — under that flag `chat?: X` means "absent
// or X", NOT "X or undefined", and Telegraf's ctx.chat is the latter.
function chatIdOf(ctx: { chat?: { id: number } | undefined }): string {
  return String(ctx.chat?.id ?? '');
}

// ---------------------------------------------------------------------------
// /start — the linking flow
// ---------------------------------------------------------------------------

bot.start(async (ctx) => {
  const chatId = chatIdOf(ctx);
  // Telegram deep links (t.me/bot?start=CODE) arrive as "/start CODE", so the
  // payload is just the second word.
  const payload = ctx.message.text.split(' ')[1]?.trim();

  if (!payload) {
    await ctx.reply(
      'Hi! I’m your accountability coach.\n\n' +
        'To connect your account, open the dashboard → Settings → Connect Telegram, ' +
        'then send me the code you get there.\n\n' +
        'Once connected: /goals to see today, /done to check something off.',
    );
    return;
  }

  try {
    const user = (await api.link(payload, chatId)) as User;
    await ctx.reply(
      `Connected — hi ${user.displayName}. 👋\n\n` +
        'Try /goals to see what’s due today.',
    );
  } catch (err) {
    await ctx.reply(
      err instanceof ApiRequestError
        ? `Couldn’t connect: ${err.message}`
        : 'Something went wrong connecting your account.',
    );
  }
});

bot.help(async (ctx) => {
  await ctx.reply(
    'What I can do:\n\n' +
      '/goals — what’s due today and how you’re doing\n' +
      '/done — mark a goal complete\n' +
      '/skip — mark a goal skipped\n' +
      '/start — connect your account',
  );
});

// ---------------------------------------------------------------------------
// /goals
// ---------------------------------------------------------------------------

bot.command('goals', async (ctx) => {
  const chatId = chatIdOf(ctx);
  const today = todayLocalDate();
  const todayDow = new Date().getDay();

  try {
    const [goals, checkIns] = await Promise.all([
      api.get<Goal[]>('/goals', chatId),
      api.get<CheckIn[]>(`/checkins?from=${today}&to=${today}`, chatId),
    ]);

    const byGoal = new Map(checkIns.map((c) => [c.goalId, c.status]));
    const due = goals.filter(
      (g) => g.status === 'active' && g.cadence.daysOfWeek.includes(todayDow),
    );

    if (due.length === 0) {
      await ctx.reply(`Nothing due today (${DAY_NAMES[todayDow]}). Enjoy it.`);
      return;
    }

    const lines = due.map((g) => {
      const status = byGoal.get(g.id);
      const mark = status === 'done' ? '✅' : status === 'skipped' ? '⏭️' : '⬜';
      return `${mark} ${g.title} — ${formatTimeOfDay(g.cadence.timeOfDay)}`;
    });

    const doneCount = due.filter((g) => byGoal.get(g.id) === 'done').length;
    await ctx.reply(`*Today* — ${doneCount}/${due.length} done\n\n${lines.join('\n')}`, {
      parse_mode: 'Markdown',
    });
  } catch (err) {
    await replyForError(ctx, err);
  }
});

// ---------------------------------------------------------------------------
// /done and /skip — both are "pick a goal, then record a status"
// ---------------------------------------------------------------------------

/**
 * One handler for both commands, because they differ only in which status
 * they write. The chosen goal comes back through a callback query — the
 * `coach:<status>:<goalId>` payload below is how Telegram tells us which
 * button was pressed.
 */
function makeCheckInCommand(status: CheckInStatus) {
  // Typed against the general `Context` rather than the narrowed command
  // context: this handler only uses `.chat` and `.reply`, which every context
  // has, and a function accepting the wider type is still assignable where a
  // narrower one is expected.
  return async (ctx: Context) => {
    const chatId = chatIdOf(ctx);
    const today = todayLocalDate();
    const todayDow = new Date().getDay();

    try {
      const goals = await api.get<Goal[]>('/goals', chatId);
      const due = goals.filter(
        (g) => g.status === 'active' && g.cadence.daysOfWeek.includes(todayDow),
      );

      if (due.length === 0) {
        await ctx.reply('Nothing due today to mark.');
        return;
      }

      await ctx.reply(
        status === 'done' ? 'Which one did you do?' : 'Which one are you skipping?',
        Markup.inlineKeyboard(
          due.map((g) => [Markup.button.callback(g.title, `coach:${status}:${g.id}`)]),
        ),
      );
    } catch (err) {
      await replyForError(ctx, err);
    }
  };
}

bot.command('done', makeCheckInCommand('done'));
bot.command('skip', makeCheckInCommand('skipped'));

/**
 * Payload: `coach:<status>:<goalId>` or `coach:<status>:<goalId>:<YYYY-MM-DD>`.
 *
 * The date is optional because buttons come from two places. `/done` (above)
 * omits it and means "today". Reminders and follow-ups sent by the WORKER
 * process include the date the reminder was FOR — so tapping Done on a
 * follow-up that arrives after midnight still records yesterday's goal, not
 * today's.
 *
 * Note this handler never cares which process sent the message. The worker
 * sends, Telegram delivers the press to whichever process is polling (this
 * one), and this code handles it.
 */
bot.action(/^coach:(done|skipped):([a-f0-9]{24})(?::(\d{4}-\d{2}-\d{2}))?$/, async (ctx) => {
  const chatId = chatIdOf(ctx);
  const status = ctx.match[1] as CheckInStatus;
  const goalId = ctx.match[2];
  const date = ctx.match[3] ?? todayLocalDate();

  try {
    await api.put<CheckIn>('/checkins', chatId, { goalId, date, status });

    // Acknowledge the button press — without this Telegram shows a spinner on
    // the button until it times out.
    await ctx.answerCbQuery(status === 'done' ? 'Nice.' : 'Logged.');
    // Replace the keyboard with a confirmation so the buttons can't be
    // pressed twice and the chat doesn't fill with dead menus.
    await ctx.editMessageText(status === 'done' ? '✅ Marked done.' : '⏭️ Marked skipped.');
  } catch (err) {
    console.error('[bot] check-in button failed:', err);
    // Best-effort only. If the FIRST answerCbQuery above failed because the
    // callback query itself is expired (e.g. the bot wasn't running when the
    // button was tapped — see LEARNINGS), this second attempt will fail for
    // the exact same reason. Without `.catch(() => {})` here, that second
    // failure goes uncaught and crashes the whole bot process — for every
    // user, over one stale tap from one person.
    await ctx.answerCbQuery('Something went wrong').catch(() => {});
    await replyForError(ctx, err).catch(() => {});
  }
});

// ---------------------------------------------------------------------------

async function replyForError(ctx: { reply: (text: string) => Promise<unknown> }, err: unknown) {
  if (err instanceof NotLinkedError) {
    await ctx.reply(
      'Your Telegram isn’t connected to an account yet.\n\n' +
        'Open the dashboard → Settings → Connect Telegram, then send me the code.',
    );
    return;
  }
  console.error('[bot] error:', err);
  await ctx.reply('Something went wrong. Try again in a moment.');
}

// Telegraf's own catch-all: anything that slips past a handler's own
// try/catch lands here and gets logged, instead of becoming an unhandled
// rejection that kills the entire process. One bad update from one user
// (an expired callback query, a malformed message) must never take the bot
// down for everyone else still using it.
bot.catch((err, ctx) => {
  console.error(`[bot] unhandled error for update ${ctx.update.update_id}:`, err);
});

/**
 * LONG POLLING, not webhooks.
 *
 * `bot.launch()` makes the bot repeatedly ASK Telegram "anything new?" —
 * which means it needs no public URL, no HTTPS, no tunnel. That's the whole
 * reason local development on this project costs nothing and needs no
 * hosting. Webhook mode (Telegram calling US) only becomes necessary at
 * deploy, and it's a config change, not a rewrite.
 */
bot.launch(() => console.log('[bot] listening (long polling)'));

// Without these, Ctrl+C leaves the polling connection open and Telegram keeps
// thinking an instance is still running — the next start then fights it.
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
