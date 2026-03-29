import json
import time
import urllib.error
import urllib.request


URL = "https://api.mitsolab.com/api/v1/chat_voyage_test"
BEARER_TOKEN = "ml_cvaysqxqHCcoVygeW777%5p4J9nkDHPGhNRAb37p"
AGENT_ID = "befcd1a8-fe43-4df8-b197-eb6f007bd148"
MESSAGE = "How much is your pricing?"
ANON_ID = "voyage-test-user"
CHAT_ID = "voyage-test-chat"
EMBEDDING_BENCHMARK_ONLY = True


def main():
    payload = {
        "agent_id": AGENT_ID,
        "message": MESSAGE,
        "anon_id": ANON_ID,
        "chat_id": CHAT_ID,
        "embedding_benchmark_only": EMBEDDING_BENCHMARK_ONLY,
    }

    request = urllib.request.Request(
        URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {BEARER_TOKEN}",
        },
        method="POST",
    )

    started_at = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            response_text = response.read().decode("utf-8")
            status_code = response.status
    except urllib.error.HTTPError as error:
        response_text = error.read().decode("utf-8", errors="replace")
        status_code = error.code
    except Exception as error:
        print(f"Request failed: {error}")
        return
    elapsed_ms = round((time.perf_counter() - started_at) * 1000, 2)

    print(f"HTTP status: {status_code}")
    print(f"Client elapsed ms: {elapsed_ms}")

    try:
        data = json.loads(response_text)
    except json.JSONDecodeError:
        print("Raw response:")
        print(response_text)
        return

    debug = data.get("debug") or {}
    rag = debug.get("rag") or {}
    timings = debug.get("timings") or {}

    print("\nServer timings:")
    print(json.dumps(timings, indent=2, ensure_ascii=False))

    print("\nRAG debug:")
    print(json.dumps(rag, indent=2, ensure_ascii=False))

    embedding_benchmark = debug.get("embeddingBenchmark") or {}
    if embedding_benchmark:
        print("\nEmbedding benchmark:")
        print(json.dumps(embedding_benchmark, indent=2, ensure_ascii=False))

    print("\nReply:")
    print(data.get("reply", ""))

    if "error" in data:
        print("\nError:")
        print(json.dumps(data, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
