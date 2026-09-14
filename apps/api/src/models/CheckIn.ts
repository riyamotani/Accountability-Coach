import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

const checkInSchema = new Schema(
  {
    goalId: { type: Schema.Types.ObjectId, ref: 'Goal', required: true },

    // Denormalized from the goal. Strictly speaking this is derivable via
    // goalId -> Goal.ownerId, but carrying it here means "list my check-ins"
    // is one query instead of a join, and the ownership check never needs a
    // second round trip. The tradeoff: if a goal ever changed hands we would
    // have to update both. Goals don't change hands, so we take the win.
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    // "YYYY-MM-DD" in the owner's timezone — a calendar day, not an instant.
    // Stored as a string so it can never drift across a timezone boundary.
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },

    status: { type: String, enum: ['done', 'partial', 'skipped'], required: true },
    value: { type: Number, min: 0 },
    note: { type: String, trim: true, maxlength: 2000 },
  },
  { timestamps: true },
);

// One check-in per goal per day, enforced by the DATABASE rather than by
// application code. Two concurrent requests (dashboard and Telegram bot at the
// same moment) can both pass an "does it exist?" check and both insert. Only a
// unique index actually prevents the duplicate.
checkInSchema.index({ goalId: 1, date: 1 }, { unique: true });

// Serves the dashboard's "my recent check-ins, newest first" query.
checkInSchema.index({ ownerId: 1, date: -1 });

export type CheckInDoc = HydratedDocument<InferSchemaType<typeof checkInSchema>>;

export const CheckInModel = model('CheckIn', checkInSchema);
