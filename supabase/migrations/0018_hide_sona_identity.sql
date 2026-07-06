-- Accountants must not learn who performs the quality checks. The kk UI now
-- shows neutral labels («Комментарии проверяющего», author «Проверяющий»);
-- this migration neutralizes the identifying strings on the data side.
-- (Applied to production via MCP on 2026-07-06.)

-- 1) kk_ingest_problems(): fallback ticket title «Проблема по проверке (Сона)»
--    → «Проблема по проверке качества». Patched in place so the rest of the
--    (heavily-evolved) function body stays exactly as deployed.
do $$
declare def text;
begin
  select pg_get_functiondef(oid) into def from pg_proc where proname = 'kk_ingest_problems';
  def := replace(def, 'Проблема по проверке (Сона)', 'Проблема по проверке качества');
  execute def;
end $$;

-- 2) Neutralize anything already stored.
update kk_problems set problem_title = 'Проблема по проверке качества'
where problem_title = 'Проблема по проверке (Сона)';

update kk_sona_comments set author = 'Проверяющий'
where author ilike '%sona%' or author like '%@%';
