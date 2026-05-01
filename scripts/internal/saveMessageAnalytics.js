async function saveMessageAnalytics({
  supId,
  supKey,
  agentId,
  workspaceId,
  endpoint = "chat",
  source = "api",
  country = null,
  anonId = null,
  chatId = null,
  modelFirstCall = "gpt-4o-mini",
  modelSecondCall = "gpt-4o-mini",
  firstInputTokens = 0,
  firstOutputTokens = 0,
  secondInputTokens = 0,
  secondOutputTokens = 0,
  actionUsed = false,
  actionCount = 0,
  ragUsed = false,
  ragChunkCount = 0,
  statusCode = 200,
  latencyTotalMs = null,
  latencyFirstCallMs = null,
  latencySecondCallMs = null,
  latencyToolsMs = null,
  errorCode = null,
}) {
  if (!supId || !supKey) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }

  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  const url = `${baseUrl}/message_analytics`;

  const asIntOrZero = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };

  const asNullableInt = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  };

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        apikey: supKey,
        Authorization: `Bearer ${supKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        agent_id: agentId ?? null,
        workspace_id: workspaceId ?? null,
        endpoint: String(endpoint || "chat"),
        source: String(source || "api"),
        country: country ?? null,
        annon: anonId ?? null,
        chat_id: chatId ?? null,
        model_first_call: String(modelFirstCall || "gpt-4o-mini"),
        model_second_call: String(modelSecondCall || "gpt-4o-mini"),
        first_input_tokens: asIntOrZero(firstInputTokens),
        first_output_tokens: asIntOrZero(firstOutputTokens),
        second_input_tokens: asIntOrZero(secondInputTokens),
        second_output_tokens: asIntOrZero(secondOutputTokens),
        action_used: Boolean(actionUsed),
        action_count: asIntOrZero(actionCount),
        rag_used: Boolean(ragUsed),
        rag_chunk_count: asIntOrZero(ragChunkCount),
        status_code: asIntOrZero(statusCode || 200) || 200,
        latency_total_ms: asNullableInt(latencyTotalMs),
        latency_first_call_ms: asNullableInt(latencyFirstCallMs),
        latency_second_call_ms: asNullableInt(latencySecondCallMs),
        latency_tools_ms: asNullableInt(latencyToolsMs),
        error_code: errorCode ? String(errorCode) : null,
      }),
    });
  } catch (error) {
    return { ok: false, status: 502, error: "Message analytics service unavailable" };
  }

  if (!response.ok) {
    return { ok: false, status: 502, error: "Message analytics service unavailable" };
  }

  return { ok: true };
}

function trackMessageAnalytics(payload) {
  const promise = saveMessageAnalytics(payload).catch(() => {});

  const waitUntilCandidates = [
    globalThis?.waitUntil,
    globalThis?.EdgeRuntime?.waitUntil,
  ];
  try {
    const vercelFunctions = require("@vercel/functions");
    waitUntilCandidates.push(vercelFunctions?.waitUntil);
  } catch (_) {}

  for (const waitUntil of waitUntilCandidates) {
    if (typeof waitUntil !== "function") continue;
    try {
      waitUntil(promise);
      return;
    } catch (_) {}
  }

  void promise;
}

module.exports = {
  saveMessageAnalytics,
  trackMessageAnalytics,
};
