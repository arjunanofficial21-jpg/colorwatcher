import asyncio
import csv
import json
import os
import re
from datetime import datetime, timedelta, timezone
from dotenv import load_dotenv
from telethon import TelegramClient

load_dotenv()

# ============================================================
# CONFIG
# ============================================================
API_ID = os.getenv("TELEGRAM_API_ID")
API_HASH = os.getenv("TELEGRAM_API_HASH")

# Colorwiz VIP group ID
GROUP_ID = -1001574277898 
SESSION_NAME = "telegram_content_collector"
IST = timezone(timedelta(hours=5, minutes=30))

JSON_FILE = "bulk_2year_results.json"
CSV_FILE = "bulk_2year_results.csv"

# ============================================================
# LOGIC
# ============================================================

async def main():
    if not API_ID or not API_HASH:
        print("ERROR: API_ID or API_HASH missing from .env")
        return

    client = TelegramClient(SESSION_NAME, int(API_ID), API_HASH)
    await client.start()
    
    # 2 years back from now
    now = datetime.now(IST)
    start_dt = now - timedelta(days=730)
    
    print(f"\n--- 2-YEAR BULK FETCH ---")
    print(f"Range: {start_dt.strftime('%Y-%m-%d')} to {now.strftime('%Y-%m-%d')}")
    print(f"Target Group ID: {GROUP_ID}")
    print("--------------------------\n")
    
    results = []
    messages_scanned = 0

    async for message in client.iter_messages(GROUP_ID, offset_date=now):
        if not message.date:
            continue
            
        msg_dt = message.date.astimezone(IST)
        
        # Stop if we go past 2 years
        if msg_dt < start_dt:
            break
            
        messages_scanned += 1
        text = message.text
        if not text:
            continue

        # Extraction logic
        normalized = re.sub(r"\s+", " ", text).strip()
        type_match = re.search(r"\b(PARITY|SAPRE|BCONE|EMERD)\b", normalized, re.IGNORECASE)
        
        if type_match:
            ctype = type_match.group(1).upper()
            after_text = normalized[type_match.end():]
            
            # Find the first number (amount)
            num_match = re.search(r"\b(\d+(?:\.\d+)?)\b", after_text)
            amount = None
            if num_match:
                val = num_match.group(1)
                amount = float(val) if "." in val else int(val)
            
            res = {
                "date": msg_dt.strftime("%Y-%m-%d"),
                "time": msg_dt.strftime("%H:%M:%S"),
                "type": ctype,
                "amount": amount,
                "text": normalized
            }
            results.append(res)
            
            # Progress print for big numbers
            if amount and amount >= 72900:
                print(f"[HIGH] {res['date']} {res['time']} | {ctype} | {amount}")
            elif messages_scanned % 1000 == 0:
                print(f"Scanned {messages_scanned} messages... ({len(results)} matches so far)")

    # Sort Oldest -> Newest
    results.sort(key=lambda x: (x['date'], x['time']))

    # Save to CSV
    with open(CSV_FILE, 'w', newline='', encoding='utf-8-sig') as f:
        writer = csv.DictWriter(f, fieldnames=["date", "time", "type", "amount", "text"])
        writer.writeheader()
        writer.writerows(results)

    # Save to JSON
    output = {
        "group_id": GROUP_ID,
        "scanned": messages_scanned,
        "matches": len(results),
        "results": results
    }
    with open(JSON_FILE, 'w', encoding='utf-8') as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"\n========================================")
    print(f"FETCH COMPLETE")
    print(f"Messages Scanned: {messages_scanned}")
    print(f"Matches Found:    {len(results)}")
    print(f"Saved to:         {CSV_FILE}")
    print(f"Saved to:         {JSON_FILE}")
    print(f"========================================\n")

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nStopped by user.")
