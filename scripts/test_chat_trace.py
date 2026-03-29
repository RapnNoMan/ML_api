import json
import sys
import time

import requests


URL = "https://api.mitsolab.com/api/v1/chat_trace"
BEARER_TOKEN = "REPLACE_WITH_AGENT_KEY"
AGENT_ID = "REPLACE_WITH_AGENT_ID"
MESSAGE = "what is your pricing"
ANON_ID = "chat-trace-user"
CHAT_ID = "chat-trace-chat"
TIMEOUT_SECONDS = 180


def main():
    payload = {
        "agent_id": AGENT_ID,
        "message": MESSAGE,
        "anon_id": ANON_ID,
        "chat_id": CHAT_ID,
    }
    headers = {
        "Authorization": f"Bearer {BEARER_TOKEN}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    }

    started_at = time.perf_counter()
    try:
      with requests.post(
          URL,
          json=payload,
          headers=headers,
          timeout=TIMEOUT_SECONDS,
          stream=True,
      ) as response:
          print(f"HTTP status: {response.status_code}")
          response.raise_for_status()

          current_event = None
          for raw_line in response.iter_lines(decode_unicode=True):
              if raw_line is None:
                  continue
              line = raw_line.strip()
              if not line:
                  continue
              if line.startswith("event:"):
                  current_event = line.split(":", 1)[1].strip()
                  continue
              if not line.startswith("data:"):
                  continue

              data_text = line.split(":", 1)[1].strip()
              try:
                  payload = json.loads(data_text)
              except json.JSONDecodeError:
                  payload = {"raw": data_text}

              elapsed_ms = round((time.perf_counter() - started_at) * 1000, 2)
              print(f"\n[{elapsed_ms} ms] event={current_event}")
              print(json.dumps(payload, indent=2, ensure_ascii=False))

              if current_event in {"done", "error"}:
                  break
    except Exception as error:
        print(f"Request failed: {error}")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
