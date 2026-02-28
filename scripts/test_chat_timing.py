import json
import sys

import requests


def main():
    url = "https://api.mitsolab.com/api/v1/chat_timing"
    payload = {
        "agent_id": "befcd1a8-fe43-4df8-b197-eb6f007bd148",
        "message": "what is mitsolab and what is your pricing?",
        "source": "api timing test",
    }
    headers = {"Authorization": "Bearer ml_cvaysqxqHCcoVygeW777%5p4J9nkDHPGhNRAb37p"}

    response = requests.post(url, json=payload, headers=headers, timeout=60)
    print(f"{response.status_code} {response.reason}")

    try:
        data = response.json()
    except Exception:
        print(response.text)
        return 1

    if response.status_code != 200:
        print(json.dumps(data, indent=2, ensure_ascii=False))
        return 1

    steps = data.get("steps_ms") or {}
    tool_calls = data.get("tool_calls_ms") or []
    result = {
        "total_ms": data.get("total_ms"),
        "tool_used": data.get("tool_used"),
        "tool_call_count": data.get("tool_call_count"),
        "model_primary": data.get("model_primary"),
        "model_followup": data.get("model_followup"),
        "primary_input_tokens": data.get("primary_input_tokens"),
        "primary_output_tokens": data.get("primary_output_tokens"),
        "followup_input_tokens": data.get("followup_input_tokens"),
        "followup_output_tokens": data.get("followup_output_tokens"),
        "steps_ms": steps,
        "tool_calls_ms": tool_calls,
    }
    print(json.dumps(result, indent=2, ensure_ascii=False))

    output_path = "scripts/test_chat_timing_output.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(
            {
                "request_body": payload,
                "status_code": response.status_code,
                "reason": response.reason,
                "url": url,
                "timing_result": result,
            },
            f,
            indent=2,
            ensure_ascii=False,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
