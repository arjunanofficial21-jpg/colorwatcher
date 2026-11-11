"""
Fetches messages from Telegram from the last known entry date up to now,
and appends them to bulk_2year_data.json (the historical baseline).
Called by start.sh on every local startup to fill the gap.
"""
import asyncio
import json
import os
import re
from datetime import datetime, timedelta, timezone
from dotenv import load_dotenv
from telethon import TelegramClient
from telethon.sessions import StringSession

load_dotenv()

API_ID           = os.getenv("TELEGRAM_API_ID")
API_HASH         = os.getenv("TELEGRAM_API_HASH")
TELEGRAM_SESSION = os.getenv("TELEGRAM_SESSION")
SESSION_NAME     = "telegram_content_collector"
GROUP_ID         = -1001574277898
IST              = timezone(timedelta(hours=5, minutes=30))
BULK_FILE        = "frontend/public/bulk_2year_data.json"


def load_bulk():
    if not os.path.exists(BULK_FILE):
        return {"results": []}
    with open(BULK_FILE, encoding="utf-8") as f:
        return json.load(f)


def save_bulk(data):
    with open(BULK_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


async def main():
    if not API_ID or not API_HASH:
        print("ERROR: TELEGRAM_API_ID or TELEGRAM_API_HASH missing from .env")
        return

    bulk = load_bulk()
    results = bulk.get("results", [])

    # Find the last known date/time in the baseline
    if results:
        last = max(results, key=lambda x: (x.get("date", ""), x.get("time", "")))
        last_dt = datetime.strptime(
            f"{last['date']} {last['time']}", "%Y-%m-%d %H:%M:%S"
        ).replace(tzinfo=IST)
        print(f"Last baseline entry: {last['date']} {last['time']}")
    else:
        last_dt = datetime.now(IST) - timedelta(days=30)
        print("No baseline found, fetching last 30 days")

    now = datetime.now(IST)
    gap_seconds = (now - last_dt).total_seconds()

    if gap_seconds < 300:  # less than 5 minutes gap — nothing to fetch
        print("Baseline is up to date, skipping gap fetch.")
        return

    print(f"Fetching gap: {last_dt.strftime('%Y-%m-%d %H:%M')} → {now.strftime('%Y-%m-%d %H:%M')}")

    # Connect using StringSession if available, else fall back to session file
    if TELEGRAM_SESSION:
        client = TelegramClient(StringSession(TELEGRAM_SESSION), int(API_ID), API_HASH)
    else:
        client = TelegramClient(SESSION_NAME, int(API_ID), API_HASH)

    await client.start()

    # Build a dedup set from existing results
    seen = {f"{r['date']}|{r['time']}|{r['type']}|{r['amount']}" for r in results}

    new_entries = []
    scanned = 0

    async for message in client.iter_messages(GROUP_ID, offset_date=now):
        if not message.date:
            continue

        msg_dt = message.date.astimezone(IST)

        # Stop once we're at or before the last known entry
        if msg_dt <= last_dt:
            break

        scanned += 1
        text = message.text
        if not text:
            continue

        normalized = re.sub(r"\s+", " ", text).strip()
        type_match = re.search(r"\b(PARITY|SAPRE|BCONE|EMERD)\b", normalized, re.IGNORECASE)

        if type_match:
            ctype = type_match.group(1).upper()
            after_text = normalized[type_match.end():]
            num_match = re.search(r"\b(\d+(?:\.\d+)?)\b", after_text)
            amount = None
            if num_match:
                val = num_match.group(1)
                amount = float(val) if "." in val else int(val)

            entry = {
                "date":   msg_dt.strftime("%Y-%m-%d"),
                "time":   msg_dt.strftime("%H:%M:%S"),
                "type":   ctype,
                "amount": amount,
                "text":   normalized,
            }
            key = f"{entry['date']}|{entry['time']}|{entry['type']}|{entry['amount']}"
            if key not in seen:
                seen.add(key)
                new_entries.append(entry)

    await client.disconnect()

    if not new_entries:
        print(f"Scanned {scanned} messages — no new entries found.")
        return

    # Sort and append
    new_entries.sort(key=lambda x: (x["date"], x["time"]))
    results.extend(new_entries)
    results.sort(key=lambda x: (x["date"], x["time"]))

    bulk["results"] = results
    bulk["matches"] = len(results)
    save_bulk(bulk)

    print(f"Gap fetch complete: {len(new_entries)} new entries added ({scanned} messages scanned)")
    print(f"Baseline now has {len(results)} total entries, last: {results[-1]['date']} {results[-1]['time']}")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nStopped.")
