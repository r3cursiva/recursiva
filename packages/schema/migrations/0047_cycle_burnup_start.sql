-- RSVA-528: a cycle's burn-up opens with a point at its first moment, before the ends of its days. Summaries frozen
-- before it have no such point; the log could give it, SQL cannot count it, so they repeat their first day's end.
UPDATE "cycle" SET "summary" = "summary"
  || jsonb_build_object(
    'scope', jsonb_build_array("summary"->'scope'->0) || ("summary"->'scope'),
    'started', jsonb_build_array("summary"->'started'->0) || ("summary"->'started'),
    'done', jsonb_build_array("summary"->'done'->0) || ("summary"->'done')
  )
WHERE "summary" IS NOT NULL AND jsonb_array_length("summary"->'scope') > 0;
