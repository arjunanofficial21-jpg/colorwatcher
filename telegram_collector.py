import asyncio
import csv
import json
import os
import re
import sys

from datetime import datetime, timezone, time, timedelta

from dotenv import load_dotenv
from telethon import TelegramClient


# ============================================================
# LOAD .ENV
# ============================================================

load_dotenv()

SESSION_NAME = "telegram_content_collector"

API_ID = os.getenv("TELEGRAM_API_ID")
API_HASH = os.getenv("TELEGRAM_API_HASH")


# ============================================================
# TIMEZONE
# ============================================================

IST = timezone(timedelta(hours=5, minutes=30))


# ============================================================
# TARGET TYPES
# ============================================================

TARGET_TYPES = {
    "PARITY",
    "SAPRE",
    "BCONE",
    "EMERD",
}


# ============================================================
# OUTPUT FILES
# ============================================================

JSON_FILE = "telegram_content_results.json"
CSV_FILE = "telegram_content_results.csv"


# ============================================================
# CHECK ENV
# ============================================================

if not API_ID:
    print("\nERROR: TELEGRAM_API_ID is missing from .env")
    sys.exit(1)

if not API_HASH:
    print("\nERROR: TELEGRAM_API_HASH is missing from .env")
    sys.exit(1)

try:
    API_ID = int(API_ID)
except ValueError:
    print("\nERROR: TELEGRAM_API_ID must be a number.")
    sys.exit(1)


# ============================================================
# DATE RANGE
# ============================================================

def get_date_range():

    while True:

        start_text = input(
            "\nEnter START date (YYYY-MM-DD): "
        ).strip()

        try:
            start_date = datetime.strptime(
                start_text,
                "%Y-%m-%d"
            ).date()
            break

        except ValueError:
            print(
                "Invalid date. Example: 2026-09-01"
            )

    while True:

        end_text = input(
            "Enter END date (YYYY-MM-DD): "
        ).strip()

        try:
            end_date = datetime.strptime(
                end_text,
                "%Y-%m-%d"
            ).date()
            break

        except ValueError:
            print(
                "Invalid date. Example: 2026-09-23"
            )

    if end_date < start_date:

        print(
            "\nERROR: End date cannot be before start date."
        )

        sys.exit(1)

    start_datetime = datetime.combine(
        start_date,
        time.min,
        tzinfo=IST
    )

    end_datetime = datetime.combine(
        end_date,
        time.max,
        tzinfo=IST
    )

    return (
        start_date,
        end_date,
        start_datetime,
        end_datetime
    )


# ============================================================
# CHOOSE TELEGRAM GROUP / CHANNEL
# ============================================================

async def choose_group(client):

    dialogs = []

    print("\nLoading Telegram groups/channels...")

    async for dialog in client.iter_dialogs():

        entity = dialog.entity

        # Ignore bots
        if getattr(entity, "bot", False):
            continue

        # Only groups/channels
        if dialog.is_group or dialog.is_channel:

            dialogs.append(dialog)

    if not dialogs:

        print("\nNo groups or channels found.")
        return None

    print("\n========================================")
    print("AVAILABLE GROUPS / CHANNELS")
    print("========================================")

    for index, dialog in enumerate(dialogs, start=1):

        name = dialog.name or "Unnamed"

        print(
            f"{index}. {name}"
        )

    print("========================================")

    while True:

        choice = input(
            "\nEnter group number: "
        ).strip()

        try:
            choice = int(choice)

            if 1 <= choice <= len(dialogs):

                selected = dialogs[choice - 1]

                print(
                    f"\nSelected: {selected.name}"
                )

                return selected

        except ValueError:
            pass

        print(
            f"Please enter a number between 1 and {len(dialogs)}."
        )


# ============================================================
# EXTRACT TARGET TYPE + ANY AMOUNT
# ============================================================

def extract_target_content(text):

    if not text:
        return None

    # Normalize spaces/newlines
    normalized_text = re.sub(
        r"\s+",
        " ",
        text
    ).strip()

    # Find one of the four target types
    type_match = re.search(
        r"\b(PARITY|SAPRE|BCONE|EMERD)\b",
        normalized_text,
        re.IGNORECASE
    )

    if not type_match:
        return None

    content_type = type_match.group(1).upper()

    # Everything after the keyword
    text_after_keyword = normalized_text[
        type_match.end():
    ]

    # ========================================================
    # ANY NUMBER IS ACCEPTED
    #
    # Examples:
    # 100
    # 270
    # 300
    # 900
    # 1000
    # 3000
    # 8100
    # 12500
    # 250.50
    # ========================================================

    amount_match = re.search(
        r"\b(\d+(?:\.\d+)?)\b",
        text_after_keyword
    )

    amount = None

    if amount_match:

        amount_text = amount_match.group(1)

        if "." in amount_text:

            amount = float(amount_text)

        else:

            amount = int(amount_text)

    return {
        "type": content_type,
        "amount": amount,
        "raw_text": normalized_text
    }


# ============================================================
# CONVERT TELEGRAM DATE TO IST
# ============================================================

def get_ist_datetime(message):

    message_date = message.date

    if not message_date:
        return None

    # Telethon normally gives timezone-aware UTC datetime.
    # Handle naive datetime safely as UTC.
    if message_date.tzinfo is None:

        message_date = message_date.replace(
            tzinfo=timezone.utc
        )

    return message_date.astimezone(IST)


# ============================================================
# SCAN GROUP
# ============================================================

async def scan_group(
    client,
    group,
    start_datetime,
    end_datetime
):

    results = []

    messages_scanned = 0

    print("\n========================================")
    print("STARTING MESSAGE SCAN")
    print("========================================")

    print(
        f"Group      : {group.name}"
    )

    print(
        f"Start date : {start_datetime.strftime('%Y-%m-%d')}"
    )

    print(
        f"End date   : {end_datetime.strftime('%Y-%m-%d')}"
    )

    print(
        "\nTarget types:"
    )

    for target in sorted(TARGET_TYPES):

        print(
            f"  - {target}"
        )

    print(
        "\nScanning Telegram messages..."
    )

    print(
        "Images/media will NOT be downloaded."
    )

    print("========================================\n")

    # Telegram returns newest -> oldest.
    # We scan backwards from the end date.
    async for message in client.iter_messages(
        group.entity,
        offset_date=end_datetime
    ):

        if not message.date:
            continue

        message_datetime = message.date

        if message_datetime.tzinfo is None:

            message_datetime = message_datetime.replace(
                tzinfo=timezone.utc
            )

        ist_datetime = message_datetime.astimezone(IST)

        # We have gone before the requested date range.
        if ist_datetime < start_datetime:

            break

        # Ignore anything beyond requested end.
        if ist_datetime > end_datetime:

            continue

        messages_scanned += 1

        # ====================================================
        # ONLY TEXT / CAPTION
        # ====================================================

        text = message.text

        if not text:
            continue

        # ====================================================
        # EXTRACT TARGET
        # ====================================================

        extracted = extract_target_content(text)

        if not extracted:
            continue

        # ====================================================
        # FINAL OUTPUT
        # ====================================================

        result = {

            "date": ist_datetime.strftime(
                "%Y-%m-%d"
            ),

            "time": ist_datetime.strftime(
                "%H:%M:%S"
            ),

            "type": extracted["type"],

            "amount": extracted["amount"],

            "text": extracted["raw_text"]
        }

        # ====================================================
        # INTERNAL SORT DATA
        #
        # Not saved to JSON/CSV.
        # Used only to guarantee chronological order.
        # ====================================================

        result["_sort_datetime"] = ist_datetime

        # Message ID is ONLY used internally as a tie-breaker.
        # It will NEVER appear in final output.
        result["_sort_message_id"] = message.id

        results.append(result)

        # Show matches while scanning

        print(
            f"[MATCH] "
            f"{result['date']} "
            f"{result['time']} | "
            f"{result['type']} | "
            f"{result['amount']} | "
            f"{result['text']}"
        )

    # ========================================================
    # CHRONOLOGICAL SORT
    #
    # Oldest -> Newest
    #
    # Important:
    # Telegram normally gives newest -> oldest.
    # We reverse that logically using timestamp sorting.
    # ========================================================

    results.sort(
        key=lambda item: (
            item["_sort_datetime"],
            item["_sort_message_id"]
        )
    )

    # ========================================================
    # REMOVE INTERNAL FIELDS
    # ========================================================

    for result in results:

        del result["_sort_datetime"]

        del result["_sort_message_id"]

    print("\n========================================")
    print("SCAN COMPLETE")
    print("========================================")

    print(
        f"Messages scanned : {messages_scanned}"
    )

    print(
        f"Matches found    : {len(results)}"
    )

    return results, messages_scanned


# ============================================================
# SAVE JSON
# ============================================================

def save_json(
    group,
    results,
    messages_scanned,
    start_date,
    end_date
):

    output = {

        "group": group.name,

        "start_date": start_date.strftime(
            "%Y-%m-%d"
        ),

        "end_date": end_date.strftime(
            "%Y-%m-%d"
        ),

        "messages_scanned": messages_scanned,

        "matches": len(results),

        "target_types": sorted(
            TARGET_TYPES
        ),

        "results": results
    }

    with open(
        JSON_FILE,
        "w",
        encoding="utf-8"
    ) as file:

        json.dump(
            output,
            file,
            ensure_ascii=False,
            indent=2
        )

    return JSON_FILE


# ============================================================
# SAVE CSV
# ============================================================

def save_csv(results):

    fields = [
        "date",
        "time",
        "type",
        "amount",
        "text"
    ]

    with open(
        CSV_FILE,
        "w",
        newline="",
        encoding="utf-8-sig"
    ) as file:

        writer = csv.DictWriter(
            file,
            fieldnames=fields
        )

        writer.writeheader()

        for result in results:

            writer.writerow(result)

    return CSV_FILE


# ============================================================
# PRINT FINAL RESULTS
# ============================================================

def print_final_results(results):

    print("\n")
    print("========================================")
    print("FINAL CHRONOLOGICAL RESULTS")
    print("========================================")

    if not results:

        print("No matching messages found.")

        return

    for index, result in enumerate(
        results,
        start=1
    ):

        print(
            f"{index}. "
            f"{result['date']} "
            f"{result['time']} | "
            f"{result['type']} | "
            f"{result['amount']} | "
            f"{result['text']}"
        )

    print("========================================")


# ============================================================
# MAIN
# ============================================================

async def main():

    print("\n")
    print("========================================")
    print(" TELEGRAM CONTENT COLLECTOR")
    print("========================================")

    print(
        "\nTarget types:"
    )

    print(
        "PARITY | SAPRE | BCONE | EMRED"
    )

    print(
        "\nAmount: ANY NUMBER"
    )

    print(
        "Examples: 100, 270, 300, 900, "
        "1000, 3000, 8100, etc."
    )

    print(
        "\nTimezone: IST"
    )

    print(
        "Output order: Oldest -> Newest"
    )

    print(
        "Images: NOT downloaded"
    )

    print("========================================")

    # ========================================================
    # CONNECT
    # ========================================================

    print(
        "\nConnecting to Telegram..."
    )

    client = TelegramClient(
        SESSION_NAME,
        API_ID,
        API_HASH
    )

    await client.start()

    print(
        "Telegram connection successful."
    )

    # ========================================================
    # GET USER
    # ========================================================

    me = await client.get_me()

    if me:

        first_name = me.first_name or ""

        username = (
            f"@{me.username}"
            if me.username
            else ""
        )

        print(
            f"Logged in as: {first_name} {username}"
        )

    # ========================================================
    # SELECT GROUP
    # ========================================================

    group = await choose_group(client)

    if not group:

        await client.disconnect()

        return

    # ========================================================
    # DATE RANGE
    # ========================================================

    (
        start_date,
        end_date,
        start_datetime,
        end_datetime
    ) = get_date_range()

    # ========================================================
    # SCAN
    # ========================================================

    results, messages_scanned = await scan_group(
        client,
        group,
        start_datetime,
        end_datetime
    )

    # ========================================================
    # SAVE JSON
    # ========================================================

    json_file = save_json(
        group,
        results,
        messages_scanned,
        start_date,
        end_date
    )

    # ========================================================
    # SAVE CSV
    # ========================================================

    csv_file = save_csv(
        results
    )

    # ========================================================
    # PRINT RESULTS
    # ========================================================

    print_final_results(
        results
    )

    # ========================================================
    # SUMMARY
    # ========================================================

    print("\n")
    print("========================================")
    print("FILES CREATED")
    print("========================================")

    print(
        f"JSON : {json_file}"
    )

    print(
        f"CSV  : {csv_file}"
    )

    print(
        f"\nTotal messages scanned : {messages_scanned}"
    )

    print(
        f"Total matching messages: {len(results)}"
    )

    print(
        "\nTarget types:"
    )

    for target in sorted(TARGET_TYPES):

        count = sum(
            1
            for result in results
            if result["type"] == target
        )

        print(
            f"  {target}: {count}"
        )

    print("========================================")

    # ========================================================
    # DISCONNECT
    # ========================================================

    await client.disconnect()

    print(
        "\nTelegram disconnected."
    )

    print(
        "Done."
    )


# ============================================================
# RUN
# ============================================================

if __name__ == "__main__":

    try:

        asyncio.run(
            main()
        )

    except KeyboardInterrupt:

        print(
            "\n\nProgram stopped by user."
        )

    except Exception as error:

        print(
            f"\n\nERROR: {error}"
        )