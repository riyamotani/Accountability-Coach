CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"content" text NOT NULL,
	"source" text NOT NULL,
	"embedding" vector(1536),
	"embedding_model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memories_content_not_empty" CHECK (length(trim("memories"."content")) > 0),
	CONSTRAINT "memories_source_valid" CHECK ("memories"."source" IN ('chat', 'checkIn', 'digest'))
);
--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memories_owner_created_idx" ON "memories" USING btree ("owner_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "memories_embedding_idx" ON "memories" USING hnsw ("embedding" vector_cosine_ops);