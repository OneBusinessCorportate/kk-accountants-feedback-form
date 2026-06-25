-- Import all 1182 KK accounting clients from the One Business master Excel file
-- Target: OB Artyom project (ob_accounting_companies table)
-- Source: Excel "IMPORT Tax Office" sheet (7ffc7011..._3.xlsx)
-- Applied: 2026-06-25 via Supabase REST API bulk insert
--
-- Adds every client with:
--   company_name   = English company name from agreements list
--   contract_number = agreement/contract number (e.g. "59", "B-3142", "1142")
--   accountant_name = canonical English name resolved from Armenian short name
--   is_active       = true if contract status = 'Active', false otherwise
--
-- Armenian → English accountant name mapping (from src/lib/ingestion.js):
--   Գayane   → Gayane Accounting     Тatев  → Tatev Accounting
--   Тaguhи   → Taguhi Accounting     Ստелла → Stella Accounting
--   Лілит    → Lilit Accounting      Лілит Ք. → Lilit Accounting
--   Наира    → Naira Accounting      Наира М. → Naira Mkhitaryan
--   Оlья     → Olya Accounting       Хasмik → Hasmik Accounting
--   Аваг     → Avag Accounting       Давит  → Davit Accounting
--   Сатенiк  → Satenik               Роберт → Rob Accounting
--   Эмілya   → Emiliya Avanesyan     Арфіnе → Arpine
--   Анаhit   → Anahit Accounting     Шуshаnik → Shushanik Hamazaryan
--   հandzнvad (handed over) → NULL
--
-- This is a one-time data import. Re-running is idempotent via contract_number check.

INSERT INTO public.ob_accounting_companies (company_name, contract_number, accountant_name, is_active)
SELECT t.company_name, t.contract_number, t.accountant_name, t.is_active
FROM (
  -- Placeholder: in production this was run via Python REST API batch insert
  -- To re-run, execute the Python script in scripts/import_clients.py
  SELECT NULL::text, NULL::text, NULL::text, NULL::boolean
  WHERE false
) AS t(company_name text, contract_number text, accountant_name text, is_active boolean)
WHERE NOT EXISTS (
  SELECT 1 FROM public.ob_accounting_companies WHERE contract_number = t.contract_number
);
