#!/usr/bin/env python3
import argparse
import json
import sys
import uuid
from urllib import error, request

# Hard-coded defaults for one-click "Run Python File" in VS Code.
DEFAULT_BASE_URL = "https://api.mitsolab.com"
DEFAULT_AGENT_ID = "befcd1a8-fe43-4df8-b197-eb6f007bd148"
DEFAULT_MESSAGE = "hello from checker test"
DEFAULT_ANON_ID = "checker-anon-001"
DEFAULT_CHAT_ID = "checker-chat-001"
DEFAULT_ORIGIN = "https://app.mitsolab.com"
DEFAULT_REFERER = "https://app.mitsolab.com/widget"
DEFAULT_TIMEOUT_SECONDS = 45.0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Send a test request to widget_checker endpoint."
    )
    parser.add_argument(
        "--base-url",
        default=DEFAULT_BASE_URL,
        help=f"API base URL (default: {DEFAULT_BASE_URL})",
    )
    parser.add_argument(
        "--agent-id",
        default=DEFAULT_AGENT_ID,
        help=f"Agent ID to test (default: {DEFAULT_AGENT_ID})",
    )
    parser.add_argument(
        "--message",
        default=DEFAULT_MESSAGE,
        help="Message payload",
    )
    parser.add_argument(
        "--anon-id",
        default=DEFAULT_ANON_ID,
        help=f"anon_id payload (default: {DEFAULT_ANON_ID})",
    )
    parser.add_argument(
        "--chat-id",
        default=DEFAULT_CHAT_ID,
        help=f"chat_id payload (default: {DEFAULT_CHAT_ID})",
    )
    parser.add_argument(
        "--origin",
        default=DEFAULT_ORIGIN,
        help="Origin header",
    )
    parser.add_argument(
        "--referer",
        default=DEFAULT_REFERER,
        help="Referer header",
    )
    parser.add_argument(
        "--skip-rag",
        action="store_true",
        help="Set run_rag=false",
    )
    parser.add_argument(
        "--skip-xai-ping",
        action="store_true",
        help="Set run_xai_ping=false",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_TIMEOUT_SECONDS,
        help=f"HTTP timeout in seconds (default: {DEFAULT_TIMEOUT_SECONDS:g})",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()

    anon_id = args.anon_id or str(uuid.uuid4())
    chat_id = args.chat_id or str(uuid.uuid4())

    url = f"{args.base_url.rstrip('/')}/v1/widget_checker/{args.agent_id}"
    payload = {
        "message": args.message,
        "anon_id": anon_id,
        "chat_id": chat_id,
    }
    if args.skip_rag:
        payload["run_rag"] = False
    if args.skip_xai_ping:
        payload["run_xai_ping"] = False

    body = json.dumps(payload).encode("utf-8")
    req = request.Request(url=url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    req.add_header("Origin", args.origin)
    req.add_header("Referer", args.referer)

    print(f"POST {url}")
    print(f"origin={args.origin}")
    print(f"referer={args.referer}")
    print(f"anon_id={anon_id}")
    print(f"chat_id={chat_id}")
    print("")

    try:
        with request.urlopen(req, timeout=args.timeout) as resp:
            status = resp.status
            raw = resp.read().decode("utf-8", errors="replace")
    except error.HTTPError as e:
        status = e.code
        raw = e.read().decode("utf-8", errors="replace")
    except Exception as e:
        print(f"Request failed: {e}", file=sys.stderr)
        return 2

    print(f"HTTP {status}")
    try:
        parsed = json.loads(raw)
        print(json.dumps(parsed, indent=2, ensure_ascii=False))
    except Exception:
        print(raw)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
