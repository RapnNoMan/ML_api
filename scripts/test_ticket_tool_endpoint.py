import json
import urllib.error
import urllib.request

# Hardcoded config: edit these if needed, then click Run in VS Code.
BASE_URL = "http://localhost:3000"
AGENT_ID = "PUT_AGENT_ID_HERE"

PAYLOAD = {
    # Keep these fixed to test the 12-hour duplicate guard behavior.
    "anon_id": "ticket-test-anon-001",
    "chat_id": "ticket-test-chat-001",
    "chat_source": "ticket_tool_test_script",
    # Intentionally provide issue only; endpoint derives subject/summary if omitted.
    "issue": "I was charged twice and need help with a refund.",
    "customer_name": "Test User",
    "customer_email": "test.user@example.com",
    # Optional:
    # "customer_phone": "+15551234567",
    # "subject": "Custom Subject",
    # "summary": "Custom Summary",
}


def main() -> None:
    url = f"{BASE_URL.rstrip('/')}/v1/ticket_tool_test?agent_id={AGENT_ID}"
    body = json.dumps(PAYLOAD).encode("utf-8")
    req = urllib.request.Request(
        url=url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            status_code = resp.status
    except urllib.error.HTTPError as err:
        raw = err.read().decode("utf-8", errors="replace")
        status_code = err.code
    except Exception as err:  # noqa: BLE001
        print("Request failed before receiving HTTP response:")
        print(str(err))
        return

    print(f"HTTP {status_code}")
    try:
        parsed = json.loads(raw)
        print(json.dumps(parsed, indent=2, ensure_ascii=False))
    except json.JSONDecodeError:
        print(raw)


if __name__ == "__main__":
    main()
