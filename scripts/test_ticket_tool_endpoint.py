import json
import urllib.parse
import urllib.error
import urllib.request

# Hardcoded config: edit these if needed, then click Run in VS Code.
BASE_URL = "http://api.mitsolab.com"
AGENT_ID = "befcd1a8-fe43-4df8-b197-eb6f007bd148"

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
    max_redirects = 5
    redirect_codes = {301, 302, 303, 307, 308}

    raw = ""
    status_code = 0
    final_url = url

    for _ in range(max_redirects + 1):
        req = urllib.request.Request(
            url=final_url,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
                status_code = resp.status
                final_url = resp.geturl()
                break
        except urllib.error.HTTPError as err:
            status_code = err.code
            if status_code in redirect_codes:
                location = err.headers.get("Location")
                if not location:
                    raw = err.read().decode("utf-8", errors="replace")
                    break
                final_url = urllib.parse.urljoin(final_url, location)
                continue
            raw = err.read().decode("utf-8", errors="replace")
            break
        except Exception as err:  # noqa: BLE001
            print("Request failed before receiving HTTP response:")
            print(str(err))
            return
    else:
        print("Too many redirects.")
        return

    print(f"HTTP {status_code}")
    if final_url != url:
        print(f"Final URL: {final_url}")
    try:
        parsed = json.loads(raw)
        print(json.dumps(parsed, indent=2, ensure_ascii=False))
    except json.JSONDecodeError:
        print(raw)


if __name__ == "__main__":
    main()
