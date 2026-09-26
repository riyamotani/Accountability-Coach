CREATE TABLE "negotiations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"goal_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"round" smallint DEFAULT 1 NOT NULL,
	"proposal" jsonb NOT NULL,
	"evidence" jsonb NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"nudged_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "negotiations_status_valid" CHECK ("status" IN ('proposed', 'agreed', 'declined', 'abandoned')),
	CONSTRAINT "negotiations_round_positive" CHECK ("negotiations"."round" >= 1)
);
--> statement-breakpoint
ALTER TABLE "negotiations" ADD CONSTRAINT "negotiations_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "negotiations" ADD CONSTRAINT "negotiations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "negotiations_one_open_per_goal" ON "negotiations" USING btree ("goal_id") WHERE status = 'proposed';--> statement-breakpoint
CREATE INDEX "negotiations_goal_created_idx" ON "negotiations" USING btree ("goal_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "negotiations_owner_status_idx" ON "negotiations" USING btree ("owner_id","status");