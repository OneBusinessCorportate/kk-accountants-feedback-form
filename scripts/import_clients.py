#!/usr/bin/env python3
"""
Import all KK accounting clients from the One Business master Excel file
into ob_accounting_companies (OB Artyom Supabase project).

Usage:
  ARTYOM_URL=https://rbtvbsbcycdlwmrzjwun.supabase.co \
  ARTYOM_ANON_KEY=<key> \
  python3 scripts/import_clients.py <path-to-xlsx>

The Excel file must have an "IMPORT Tax Office" sheet with columns:
  [0] HVHH  [1] contract_number  [2] company_name  [7] status  [8] accountant (Armenian)
"""

import openpyxl
import re
import json
import ssl
import sys
import os
import urllib.request

SUPABASE_URL = os.environ.get("ARTYOM_URL", "https://rbtvbsbcycdlwmrzjwun.supabase.co")
SUPABASE_KEY = os.environ.get("ARTYOM_ANON_KEY", "")

INGESTION_JS = os.path.join(os.path.dirname(__file__), "../src/lib/ingestion.js")


def load_alias_map():
    with open(INGESTION_JS, "r", encoding="utf-8") as f:
        content = f.read()
    pattern = r"\['([^']+)',\s*'([^']+)',\s*'([^']+)'\]"
    entries = re.findall(pattern, content)
    alias_map = {alias.strip().lower(): name for alias, _, name in entries}
    alias_map["անահիտ"] = "Anahit Accounting"
    alias_map["շուշանիկ"] = "Shushanik Hamazaryan"
    return alias_map


def resolve_accountant(raw, alias_map):
    if not raw:
        return None
    return alias_map.get(str(raw).strip().lower())


def insert_rows(rows, ctx):
    data = json.dumps(rows).encode("utf-8")
    req = urllib.request.Request(
        SUPABASE_URL + "/rest/v1/ob_accounting_companies",
        data=data,
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": "Bearer " + SUPABASE_KEY,
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=30) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def main():
    xlsx_path = sys.argv[1] if len(sys.argv) > 1 else None
    if not xlsx_path:
        print("Usage: python3 scripts/import_clients.py <path-to-xlsx>", file=sys.stderr)
        sys.exit(1)

    alias_map = load_alias_map()

    wb = openpyxl.load_workbook(xlsx_path, read_only=True, data_only=True)
    ws = wb["IMPORT Tax Office"]
    rows = list(ws.iter_rows(values_only=True))
    wb.close()

    companies = []
    seen = set()
    for r in rows[2:]:
        if len(r) < 9:
            continue
        contract, company_name, status_raw, accountant_arm = r[1], r[2], r[7], r[8]
        if not contract or not company_name:
            continue
        contract = str(contract).strip()
        company_name = str(company_name).strip()
        if not contract or not company_name or contract in seen:
            continue
        seen.add(contract)
        is_active = str(status_raw or "").strip().lower().startswith("active")
        companies.append({
            "company_name": company_name,
            "contract_number": contract,
            "accountant_name": resolve_accountant(accountant_arm, alias_map),
            "is_active": is_active,
        })

    print(f"Prepared {len(companies)} companies")

    ca_bundle = "/root/.ccr/ca-bundle.crt"
    ctx = ssl.create_default_context()
    if os.path.exists(ca_bundle):
        ctx.load_verify_locations(ca_bundle)

    BATCH = 100
    inserted = 0
    for i in range(0, len(companies), BATCH):
        batch = companies[i : i + BATCH]
        status, body = insert_rows(batch, ctx)
        if status in (200, 201):
            inserted += len(batch)
            print(f"  Batch {i//BATCH+1}: OK ({inserted}/{len(companies)})")
        else:
            print(f"  Batch {i//BATCH+1} FAILED ({status}): {body.decode()[:300]}")

    print(f"Done: {inserted} inserted")


if __name__ == "__main__":
    main()
