import argparse
import json
import sys

import requests


def parse_args():
    parser = argparse.ArgumentParser(description="Test MitsoLab chat endpoint.")
    parser.add_argument("--url", default="https://api.mitsolab.com/v1/chat")
    parser.add_argument("--api-key", required=True)
    parser.add_argument("--agent-id", required=True)
    parser.add_argument("--anon-id", type=int)
    parser.add_argument("--chat-id", type=int)
    parser.add_argument("--source")
    return parser.parse_args()


def main():
    args = parse_args()

    payload = {
        "api_key": args.api_key,
        "agent_id": args.agent_id,
    }
    if args.anon_id is not None:
        payload["anon_id"] = args.anon_id
    if args.chat_id is not None:
        payload["chat_id"] = args.chat_id
    if args.source is not None:
        payload["source"] = args.source

    response = requests.post(args.url, json=payload, timeout=30)
    print("Status:", response.status_code)
    try:
        data = response.json()
        print(json.dumps(data, indent=2))
    except ValueError:
        print(response.text)


if __name__ == "__main__":
    sys.exit(main())
