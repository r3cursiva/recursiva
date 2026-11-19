CREATE TABLE "document_version" (
	"document_id" uuid NOT NULL,
	"tx_id" uuid NOT NULL,
	"doc" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_version_document_id_tx_id_pk" PRIMARY KEY("document_id","tx_id")
);
--> statement-breakpoint
ALTER TABLE "document_version" ADD CONSTRAINT "document_version_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_version_document_id_created_at_index" ON "document_version" USING btree ("document_id","created_at");