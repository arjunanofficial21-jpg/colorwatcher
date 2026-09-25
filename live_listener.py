import asyncio
import json
import os
import re
import sys
import threading
from datetime import datetime, timezone, timedelta
from http.server import BaseHTTPRequestHandler, HTTPServer

from dotenv import load_dotenv
from telethon import TelegramClient, events
from telethon.sessions import StringSession


# ============================================================
# LOAD .ENV
# ============================================================

load_dotenv()

SESSION_NAME     = "telegram_content_collector"
API_ID           = os.getenv("TELEGRAM_API_ID")
API_HASH         = os.getenv("TELEGRAM_API_HASH")
TELEGRAM_SESSION = os.getenv("TELEGRAM_SESSION")   # StringSession for Render
GROUP_ID_ENV     = os.getenv("TELEGRAM_GROUP_ID", "-1001574277898")  # Colorwiz VIP

IST          = timezone(timedelta(hours=5, minutes=30))
TARGET_TYPES = {"PARITY", "SAPRE", "BCONE", "EMERD"}
JSON_FILE    = "telegram_content_results.json"
PUBLIC_JSON  = "frontend/public/data.json"   # served as /data.json by Vite
CONFIG_FILE  = "listener_config.json"
PORT         = int(os.getenv("PORT", 8000))  # Render sets PORT automatically


# ============================================================
# VALIDATE ENV
# ============================================================

if not API_ID:
    print("ERROR: TELEGRAM_API_ID missing from .env")
    sys.exit(1)

if not API_HASH:
    print("ERROR: TELEGRAM_API_HASH missing from .env")
    sys.exit(1)

try:
    API_ID = int(API_ID)
except ValueError:
    print("ERROR: TELEGRAM_API_ID must be a number.")
    sys.exit(1)


# ============================================================
# SHARED DATA STATE
# ============================================================

_lock = threading.Lock()

_state = {
    "group": "",
    "messages_scanned": 0,
    "matches": 0,
    "target_types": sorted(TARGET_TYPES),
    "results": [],
    "last_updated": None,
    "live": True,
}


# ============================================================
# EXTRACT TARGET TYPE + AMOUNT  (same logic as collector)
# ============================================================

def extract_target_content(text):

    if not text:
        return None

    normalized = re.sub(r"\s+", " ", text).strip()

    type_match = re.search(
        r"\b(PARITY|SAPRE|BCONE|EMERD)\b",
        normalized,
        re.IGNORECASE,
    )

    if not type_match:
        return None

    content_type   = type_match.group(1).upper()
    text_after_kw  = normalized[type_match.end():]

    amount_match = re.search(r"\b(\d+(?:\.\d+)?)\b", text_after_kw)
    amount = None

    if amount_match:
        raw = amount_match.group(1)
        amount = float(raw) if "." in raw else int(raw)

    return {"type": content_type, "amount": amount, "raw_text": normalized}


# ============================================================
# LOAD / SAVE JSON
# ============================================================

def load_existing_data():
    if not os.path.exists(JSON_FILE):
        print("No existing JSON found — starting fresh.")
        return

    with open(JSON_FILE, encoding="utf-8") as f:
        saved = json.load(f)

    with _lock:
        _state["group"]            = saved.get("group", "")
        _state["messages_scanned"] = saved.get("messages_scanned", 0)
        _state["matches"]          = saved.get("matches", 0)
        _state["results"]          = saved.get("results", [])
        _state["last_updated"]     = datetime.now(IST).isoformat()

    print(f"Loaded {len(_state['results'])} existing results from {JSON_FILE}")


def save_json():
    """Write current results to JSON file and the frontend public folder."""
    output = {
        "group":            _state["group"],
        "messages_scanned": _state["messages_scanned"],
        "matches":          _state["matches"],
        "target_types":     _state["target_types"],
        "results":          _state["results"],
    }
    for path in (JSON_FILE, PUBLIC_JSON):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(output, f, ensure_ascii=False, indent=2)


# ============================================================
# HTTP API SERVER  (runs in background thread)
# ============================================================

class APIHandler(BaseHTTPRequestHandler):

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors_headers()
        self.end_headers()

    def do_GET(self):
        if self.path.rstrip("/") in ("", "/data"):
            with _lock:
                body = json.dumps(_state, default=str, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self._cors_headers()
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin",  "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def log_message(self, format, *args):
        pass  # silence request logs


def _run_server():
    server = HTTPServer(("0.0.0.0", PORT), APIHandler)
    server.serve_forever()


# ============================================================
# GROUP CONFIG
# ============================================================

def load_config():
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE) as f:
            return json.load(f)
    return None


def save_config(group_id, group_name):
    with open(CONFIG_FILE, "w") as f:
        json.dump({"group_id": group_id, "group_name": group_name}, f, indent=2)


async def choose_group(client):
    # On Render: use env var directly, no interactive prompt
    if GROUP_ID_ENV:
        group_id = int(GROUP_ID_ENV)
        # Normalize: bare positive IDs are channel/supergroup IDs — add -100 prefix
        if group_id > 0:
            group_id = int(f"-100{group_id}")
        try:
            entity = await client.get_entity(group_id)
            name = getattr(entity, "title", None) or getattr(entity, "first_name", str(group_id))
        except Exception:
            name = str(group_id)
        print(f"\nUsing group from env: {name} (ID: {group_id})\n")
        return group_id, name

    config = load_config()

    if config:
        print(f"\nUsing saved group: {config['group_name']}")
        print("(Delete listener_config.json to change group)\n")
        return config["group_id"], config["group_name"]

    dialogs = []
    print("\nLoading Telegram groups/channels...")

    async for dialog in client.iter_dialogs():
        entity = dialog.entity
        if getattr(entity, "bot", False):
            continue
        if dialog.is_group or dialog.is_channel:
            dialogs.append(dialog)

    if not dialogs:
        print("No groups or channels found.")
        return None, None

    print("\n========================================")
    print("AVAILABLE GROUPS / CHANNELS")
    print("========================================")
    for i, d in enumerate(dialogs, 1):
        print(f"{i}. {d.name or 'Unnamed'}")
    print("========================================")

    while True:
        choice = input("\nEnter group number: ").strip()
        try:
            idx = int(choice) - 1
            if 0 <= idx < len(dialogs):
                d = dialogs[idx]
                gid  = d.entity.id
                name = d.name or "Unnamed"
                save_config(gid, name)
                print(f"\nSelected and saved: {name}")
                return gid, name
        except ValueError:
            pass
        print(f"Please enter a number between 1 and {len(dialogs)}.")


# ============================================================
# MAIN
# ============================================================

async def main():

    print("\n========================================")
    print(" TELEGRAM LIVE LISTENER")
    print("========================================")

    # Load historical data
    load_existing_data()

    # Start API server in background thread
    t = threading.Thread(target=_run_server, daemon=True)
    t.start()
    print(f"\nAPI server running → http://localhost:{PORT}/data")

    # Connect to Telegram
    # On Render: use StringSession from env var (no file storage needed)
    # Locally: use file-based session
    print("\nConnecting to Telegram...")
    session = StringSession(TELEGRAM_SESSION) if TELEGRAM_SESSION else SESSION_NAME
    client = TelegramClient(session, API_ID, API_HASH)
    await client.start()
    print("Telegram connected.")

    me = await client.get_me()
    if me:
        name = me.first_name or ""
        uname = f"@{me.username}" if me.username else ""
        print(f"Logged in as: {name} {uname}")

    # Choose group (from config or interactively)
    group_id, group_name = await choose_group(client)

    if not group_id:
        await client.disconnect()
        return

    with _lock:
        _state["group"] = group_name
        _state["last_updated"] = datetime.now(IST).isoformat()

    print("========================================")
    print(f" Listening: {group_name}")
    print(f" Dashboard: open the frontend and")
    print(f"   it will auto-update live.")
    print(" Press Ctrl+C to stop.")
    print("========================================\n")

    # --------------------------------------------------------
    # CATCH-UP: fetch any messages missed since last save
    # --------------------------------------------------------

    await catchup_scan(client, group_id)

    # --------------------------------------------------------
    # REAL-TIME EVENT LISTENER
    # --------------------------------------------------------

    @client.on(events.NewMessage(chats=group_id))
    async def handle_new_message(event):

        message = event.message

        if not message.text:
            return

        extracted = extract_target_content(message.text)

        if not extracted:
            return

        msg_date = message.date
        if msg_date.tzinfo is None:
            msg_date = msg_date.replace(tzinfo=timezone.utc)

        ist_dt = msg_date.astimezone(IST)

        result = {
            "date":   ist_dt.strftime("%Y-%m-%d"),
            "time":   ist_dt.strftime("%H:%M:%S"),
            "type":   extracted["type"],
            "amount": extracted["amount"],
            "text":   extracted["raw_text"],
        }

        with _lock:
            _state["results"].append(result)
            _state["messages_scanned"] += 1
            _state["matches"]          = len(_state["results"])
            _state["last_updated"]     = ist_dt.isoformat()
            save_json()

        print(
            f"[LIVE] "
            f"{result['date']} {result['time']} | "
            f"{result['type']} | "
            f"{result['amount']} | "
            f"{result['text']}"
        )

    await client.run_until_disconnected()


# ============================================================
# CATCH-UP SCAN  (fetch missed messages since last saved date)
# ============================================================

async def catchup_scan(client, group_id):
    """Scan messages from the day after the last saved result up to now."""

    with _lock:
        results = list(_state["results"])

    # Find the latest datetime already in our data
    if results:
        latest_str = max(
            f"{r['date']}T{r['time']}"
            for r in results
        )
        last_dt = datetime.fromisoformat(latest_str).replace(tzinfo=IST)
        # Start scanning from 1 second after the last known message
        scan_from = last_dt + timedelta(seconds=1)
    else:
        # No existing data — scan today from midnight IST
        today = datetime.now(IST).date()
        scan_from = datetime(today.year, today.month, today.day,
                             tzinfo=IST)

    now = datetime.now(IST)

    # Nothing to catch up
    if scan_from >= now:
        print("Already up to date — no catch-up needed.\n")
        return

    print(f"Catch-up scan: {scan_from.strftime('%Y-%m-%d %H:%M:%S')} → now")
    print("Fetching missed messages...\n")

    new_results = []
    scanned     = 0

    async for message in client.iter_messages(
        group_id,
        offset_date=now,
    ):
        if not message.date:
            continue

        msg_date = message.date
        if msg_date.tzinfo is None:
            msg_date = msg_date.replace(tzinfo=timezone.utc)

        ist_dt = msg_date.astimezone(IST)

        # Stop once we go before our scan_from boundary
        if ist_dt < scan_from:
            break

        scanned += 1

        if not message.text:
            continue

        extracted = extract_target_content(message.text)
        if not extracted:
            continue

        new_results.append({
            "date":   ist_dt.strftime("%Y-%m-%d"),
            "time":   ist_dt.strftime("%H:%M:%S"),
            "type":   extracted["type"],
            "amount": extracted["amount"],
            "text":   extracted["raw_text"],
            "_sort":  ist_dt,
            "_id":    message.id,
        })

    # Sort oldest → newest
    new_results.sort(key=lambda r: (r["_sort"], r["_id"]))
    for r in new_results:
        del r["_sort"]
        del r["_id"]

    if new_results:
        with _lock:
            _state["results"].extend(new_results)
            _state["messages_scanned"] += scanned
            _state["matches"]           = len(_state["results"])
            _state["last_updated"]      = now.isoformat()
            save_json()

        print(f"Catch-up complete: {len(new_results)} new matches found ({scanned} messages scanned)\n")
        for r in new_results:
            print(f"  [CATCHUP] {r['date']} {r['time']} | {r['type']} | {r['amount']}")
        print()
    else:
        print(f"Catch-up complete: 0 new matches ({scanned} messages scanned)\n")


# ============================================================
# RUN
# ============================================================

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nListener stopped.")
    except Exception as e:
        print(f"\nERROR: {e}")
