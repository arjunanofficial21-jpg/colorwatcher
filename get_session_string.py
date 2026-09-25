"""
Run this ONCE locally to get your Telegram session string.
Paste the output into Render as the TELEGRAM_SESSION env var.

Usage:
    source venv/bin/activate
    python get_session_string.py
"""

import os
from dotenv import load_dotenv
from telethon.sync import TelegramClient
from telethon.sessions import StringSession

load_dotenv()

API_ID   = int(os.getenv("TELEGRAM_API_ID"))
API_HASH = os.getenv("TELEGRAM_API_HASH")

with TelegramClient(StringSession(), API_ID, API_HASH) as client:
    session_string = client.session.save()

print("\n" + "="*60)
print("YOUR SESSION STRING (copy this into Render env vars):")
print("="*60)
print(session_string)
print("="*60 + "\n")
print("Set this as:  TELEGRAM_SESSION = <the string above>")
