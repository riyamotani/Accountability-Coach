import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

/**
 * Note what is NOT here: a `password` field. We store `passwordHash` only.
 * Naming it that way makes it structurally impossible to write
 * `user.password = req.body.password` and accidentally persist a plaintext
 * secret — the field simply doesn't exist.
 */
const userSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: { type: String, required: true },
    displayName: { type: String, required: true, trim: true },
    timezone: { type: String, required: true, default: 'UTC' },

    // Sparse: only documents that HAVE this field participate in the unique
    // index. Without `sparse`, every user with no linked Telegram account
    // would collide on `null` and the second signup would fail.
    telegramChatId: { type: String, unique: true, sparse: true },
  },
  { timestamps: true },
);

export type UserDoc = HydratedDocument<InferSchemaType<typeof userSchema>>;

export const UserModel = model('User', userSchema);
