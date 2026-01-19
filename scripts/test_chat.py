import json
import sys

import requests


def main():
    url = "https://api.mitsolab.com/v1/chat"
    payload = {
        "agent_id": "AGENT123",
        "anon_id": 1,
        "chat_id": 99,
        "source": "api test",
    }
    headers = {"Authorization": "Bearer key_333"}

    response = requests.post(url, json=payload, headers=headers, timeout=30)
    print(f"{response.status_code} {response.reason}")
    print(response.text)


if __name__ == "__main__":
    sys.exit(main())
