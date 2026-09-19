CREATE TYPE "public"."check_in_status" AS ENUM('done', 'partial', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."goal_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."pending_action_kind" AS ENUM('pauseWindow', 'checkIn');--> statement-breakpoint
CREATE TABLE "check_ins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"goal_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"date" date NOT NULL,
	"status" "check_in_status" NOT NULL,
	"value" double precision,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "check_ins_goal_date_unique" UNIQUE("goal_id","date"),
	CONSTRAINT "check_ins_value_non_negative" CHECK ("check_ins"."value" IS NULL OR "check_ins"."value" >= 0)
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"days_of_week" smallint[] NOT NULL,
	"time_of_day" text NOT NULL,
	"target" double precision,
	"target_unit" text,
	"status" "goal_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goals_days_of_week_valid" CHECK (cardinality("goals"."days_of_week") > 0 AND "goals"."days_of_week" <@ ARRAY[0,1,2,3,4,5,6]::smallint[]),
	CONSTRAINT "goals_time_of_day_format" CHECK ("goals"."time_of_day" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
	CONSTRAINT "goals_target_non_negative" CHECK ("goals"."target" IS NULL OR "goals"."target" >= 0)
);
--> statement-breakpoint
CREATE TABLE "link_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "link_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "pause_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pause_windows_range_valid" CHECK ("pause_windows"."from_date" <= "pause_windows"."to_date")
);
--> statement-breakpoint
CREATE TABLE "pending_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "pending_action_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pending_actions_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "schedule_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"label" text NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"days_of_week" smallint[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_blocks_days_of_week_valid" CHECK (cardinality("schedule_blocks"."days_of_week") > 0 AND "schedule_blocks"."days_of_week" <@ ARRAY[0,1,2,3,4,5,6]::smallint[]),
	CONSTRAINT "schedule_blocks_start_time_format" CHECK ("schedule_blocks"."start_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
	CONSTRAINT "schedule_blocks_end_time_format" CHECK ("schedule_blocks"."end_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"telegram_chat_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_telegram_chat_id_unique" UNIQUE("telegram_chat_id"),
	CONSTRAINT "users_email_lowercase" CHECK ("users"."email" = lower("users"."email"))
);
--> statement-breakpoint
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_codes" ADD CONSTRAINT "link_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pause_windows" ADD CONSTRAINT "pause_windows_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_actions" ADD CONSTRAINT "pending_actions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_blocks" ADD CONSTRAINT "schedule_blocks_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "check_ins_owner_date_idx" ON "check_ins" USING btree ("owner_id","date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "goals_owner_status_idx" ON "goals" USING btree ("owner_id","status");--> statement-breakpoint
CREATE INDEX "link_codes_user_idx" ON "link_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "link_codes_expires_at_idx" ON "link_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "pause_windows_owner_range_idx" ON "pause_windows" USING btree ("owner_id","from_date","to_date");--> statement-breakpoint
CREATE INDEX "pending_actions_expires_at_idx" ON "pending_actions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "schedule_blocks_owner_idx" ON "schedule_blocks" USING btree ("owner_id");