import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

/**
 * A short-lived, single-use code that proves "the person typing this into
 * Telegram is the same person logged into the dashboard".
 *
 * Its own collection rather than fields on User, so that the TTL index below
 * can garbage-collect expired codes without touching user documents.
 */
const linkCodeSchema = new Schema(
  {
    code: { type: String, required: true, unique: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

/**
 * A Mongo TTL index: `expireAfterSeconds: 0` means "delete this document
 * once the date in `expiresAt` has passed". Mongo does it itself — no cron
 * job, no cleanup script, nothing for us to remember to run.
 *
 * IMPORTANT CAVEAT: the background process that enforces this only runs about
 * once a minute, so an expired code can physically still exist for up to ~60s
 * after it expired. Never treat "the row exists" as "the code is valid" — the
 * redeem handler checks `expiresAt` explicitly. The index is housekeeping,
 * not a security boundary.
 */
linkCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type LinkCodeDoc = HydratedDocument<InferSchemaType<typeof linkCodeSchema>>;

export const LinkCodeModel = model('LinkCode', linkCodeSchema);
