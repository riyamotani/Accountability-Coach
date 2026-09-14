import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const scheduleBlockSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    label: { type: String, required: true, trim: true, maxlength: 60 },

    // Both in the OWNER's timezone, never UTC — same rule as Goal.cadence.
    // endTime <= startTime is legal and means the block wraps past midnight
    // (sleep 23:00-07:00), so there is deliberately no validator asserting
    // end > start.
    startTime: { type: String, required: true, match: TIME_PATTERN },
    endTime: { type: String, required: true, match: TIME_PATTERN },

    daysOfWeek: {
      type: [Number],
      required: true,
      validate: {
        validator: (v: number[]) =>
          v.length > 0 && v.every((d) => Number.isInteger(d) && d >= 0 && d <= 6),
        message: 'daysOfWeek must be a non-empty array of integers 0-6',
      },
    },
  },
  { timestamps: true },
);

export type ScheduleBlockDoc = HydratedDocument<InferSchemaType<typeof scheduleBlockSchema>>;

export const ScheduleBlockModel = model('ScheduleBlock', scheduleBlockSchema);
