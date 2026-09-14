import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

const cadenceSchema = new Schema(
  {
    daysOfWeek: {
      type: [Number],
      required: true,
      validate: {
        validator: (v: number[]) =>
          v.length > 0 && v.every((d) => Number.isInteger(d) && d >= 0 && d <= 6),
        message: 'daysOfWeek must be a non-empty array of integers 0-6',
      },
    },
    // "HH:mm", 24-hour, in the OWNER's timezone.
    timeOfDay: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
  },
  { _id: false }, // Embedded value object, not an entity — it needs no id.
);

const goalSchema = new Schema(
  {
    // The multi-user decision, made concrete. Every goal is owned, and every
    // query filters on this. A missing ownerId filter is a data leak, so it is
    // `required` and indexed rather than optional.
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 2000 },
    cadence: { type: cadenceSchema, required: true },
    target: { type: Number, min: 0 },
    targetUnit: { type: String, trim: true, maxlength: 32 },
    status: { type: String, enum: ['active', 'archived'], default: 'active', index: true },
  },
  { timestamps: true },
);

// The scheduler will repeatedly ask "which active goals does
// this user have?". A compound index serves that far better than two separate
// single-field indexes, because Mongo can only use one index per query stage.
goalSchema.index({ ownerId: 1, status: 1 });

export type GoalDoc = HydratedDocument<InferSchemaType<typeof goalSchema>>;

export const GoalModel = model('Goal', goalSchema);
