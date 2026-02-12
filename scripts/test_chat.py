import json
import sys

import requests


def main():
    url = "https://api.mitsolab.com/v1/chat"
    payload = {
        "agent_id": "befcd1a8-fe43-4df8-b197-eb6f007bd148",
        "message": "can you book a meeting tomorrow on 1pm. haircut",
#        "anon_id": 1,
#        "chat_id": 99,
        "source": "api test",
    }
    headers = {"Authorization": "Bearer key_333"}

    response = requests.post(url, json=payload, headers=headers, timeout=30)
    print(f"{response.status_code} {response.reason}")
    try:
        response_json = response.json()
        print(json.dumps(response_json, indent=2, ensure_ascii=False))
    except Exception:
        print(response.text)

    output_path = "scripts/test_chat_output.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(
            {
                "request_body": payload,
                "response_json": response_json if "response_json" in locals() else None,
                "response_text": response.text,
                "status_code": response.status_code,
                "reason": response.reason,
                "url": url,
            },
            f,
            indent=2,
            ensure_ascii=False,
        )


if __name__ == "__main__":
    sys.exit(main())
