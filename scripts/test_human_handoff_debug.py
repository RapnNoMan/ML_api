import json
import sys

import requests


def main():
    url = "https://api.mitsolab.com/v1/human_handoff_debug"

    # Hardcoded values: update these before running.
    payload = {
        "agent_id": "befcd1a8-fe43-4df8-b197-eb6f007bd148",
        "chat_source": "widget",
        "chat_id": "widget:debug-thread:debug-user",
        "anon_id": "debug-anon",
        "country": "US",
        "source": "Website",
        "message": "User asked to speak to a human.",
        "subject": "Human handoff debug",
        "summery": "Debug check for handoff gating and assignment.",
        # False = gating checks only, True = also attempts assignment RPC.
        "run_assignment": False,
    }

    # Optional: only needed if HUMAN_HANDOFF_DEBUG_KEY is configured on API env.
    debug_key = ""
    headers = {
        "Content-Type": "application/json",
    }
    if debug_key:
        headers["x-debug-key"] = debug_key

    response = requests.post(url, json=payload, headers=headers, timeout=60)
    print(f"{response.status_code} {response.reason}")

    try:
        data = response.json()
        print(json.dumps(data, indent=2, ensure_ascii=False))
    except Exception:
        data = None
        print(response.text)

    output_path = "scripts/test_human_handoff_debug_output.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(
            {
                "url": url,
                "request_body": payload,
                "status_code": response.status_code,
                "reason": response.reason,
                "response_json": data,
                "response_text": response.text,
            },
            f,
            indent=2,
            ensure_ascii=False,
        )


if __name__ == "__main__":
    sys.exit(main())

