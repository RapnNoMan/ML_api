import json
import time
import urllib.error
import urllib.request


URL = "https://api.mitsolab.com/api/v1/rag_debug"
BEARER_TOKEN = "REPLACE_WITH_AGENT_KEY"
AGENT_ID = "REPLACE_WITH_AGENT_ID"
MESSAGE = "What are your pricing options?"
ANON_ID = "rag-debug-user"
CHAT_ID = "rag-debug-chat"


def print_items(title, items, include_rerank=False):
    print(f"\n{title} ({len(items)}):")
    if not items:
        print("  none")
        return

    for index, item in enumerate(items, start=1):
        vector_score = item.get("score")
        rerank_score = item.get("rerank_score")
        skipped_reason = item.get("skipped_reason")
        chunk_text = item.get("chunk_text", "")
        preview = chunk_text.replace("\n", " ").strip()
        if len(preview) > 180:
            preview = preview[:177] + "..."

        line = f"  {index}. vector={vector_score}"
        if include_rerank:
            line += f", rerank={rerank_score}"
        if skipped_reason:
            line += f", skipped_reason={skipped_reason}"
        print(line)
        print(f"     {preview}")


def main():
    payload = {
        "agent_id": AGENT_ID,
        "message": MESSAGE,
        "anon_id": ANON_ID,
        "chat_id": CHAT_ID,
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

    if "error" in data:
        print(json.dumps(data, indent=2, ensure_ascii=False))
        return

    print(f"\nSkipped: {data.get('skipped')}")
    print(f"Total ms: {data.get('totalMs')}")

    debug = data.get("debug") or {}
    print("\nSummary:")
    summary = {
        "rerankUsed": debug.get("rerankUsed"),
        "skipRerank": debug.get("skipRerank"),
        "vectorCandidateCount": debug.get("vectorCandidateCount"),
        "vectorFilteredCount": debug.get("vectorFilteredCount"),
        "finalChunkCount": debug.get("finalChunkCount"),
        "timings": debug.get("timings"),
        "thresholds": debug.get("thresholds"),
        "topVectorScores": debug.get("topVectorScores"),
        "topRerankScores": debug.get("topRerankScores"),
    }
    print(json.dumps(summary, indent=2, ensure_ascii=False))

    print_items("Final chunks sent to LLM", debug.get("finalCandidates") or [], include_rerank=True)
    print_items("Skipped by vector threshold", debug.get("skippedByVectorThreshold") or [], include_rerank=False)
    print_items("Rerank returned candidates", debug.get("rerankReturnedCandidates") or [], include_rerank=True)
    print_items("Skipped by rerank threshold", debug.get("skippedByRerankThreshold") or [], include_rerank=True)


if __name__ == "__main__":
    main()
