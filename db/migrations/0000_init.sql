CREATE TABLE "agents" (
	"id" bigint PRIMARY KEY NOT NULL,
	"name" text,
	"email" text,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" bigint PRIMARY KEY NOT NULL,
	"ticket_id" bigint NOT NULL,
	"message_id" bigint NOT NULL,
	"name" text NOT NULL,
	"content_type" text,
	"size" integer
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" bigint PRIMARY KEY NOT NULL,
	"name" text,
	"email" text,
	"company_id" bigint,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" bigint PRIMARY KEY NOT NULL,
	"ticket_id" bigint NOT NULL,
	"idx" integer NOT NULL,
	"incoming" boolean NOT NULL,
	"private" boolean DEFAULT false NOT NULL,
	"source" integer,
	"user_id" bigint,
	"from_email" text,
	"to_emails" text[],
	"cc_emails" text[],
	"body_html" text,
	"body_text" text,
	"body_clean" text,
	"inline_images" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(body_clean, ''))) STORED
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread_summaries" (
	"ticket_id" bigint NOT NULL,
	"upto_idx" integer NOT NULL,
	"summary" text NOT NULL,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_summaries_ticket_id_upto_idx_pk" PRIMARY KEY("ticket_id","upto_idx")
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" bigint PRIMARY KEY NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"status" integer NOT NULL,
	"priority" integer,
	"source" integer,
	"product" text,
	"type" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"requester_id" bigint,
	"responder_id" bigint,
	"group_id" bigint,
	"company_id" bigint,
	"to_emails" text[],
	"spam" boolean DEFAULT false NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"last_customer_at" timestamp with time zone,
	"last_agent_at" timestamp with time zone,
	"last_public_from" text,
	"custom_fields" jsonb,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(subject, ''))) STORED
);
--> statement-breakpoint
CREATE INDEX "attachments_ticket_idx" ON "attachments" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "contacts_email_idx" ON "contacts" USING btree ("email");--> statement-breakpoint
CREATE INDEX "messages_ticket_idx" ON "messages" USING btree ("ticket_id","idx");--> statement-breakpoint
CREATE INDEX "messages_search_idx" ON "messages" USING gin ("search");--> statement-breakpoint
CREATE INDEX "tickets_updated_idx" ON "tickets" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "tickets_status_idx" ON "tickets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tickets_requester_idx" ON "tickets" USING btree ("requester_id");--> statement-breakpoint
CREATE INDEX "tickets_search_idx" ON "tickets" USING gin ("search");