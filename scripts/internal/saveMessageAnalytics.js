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
  modelMini = "gpt-5-mini",
  modelNano = "gpt-5-nano",
  miniInputTokens = 0,
  miniOutputTokens = 0,
  nanoInputTokens = 0,
  nanoOutputTokens = 0,
  actionUsed = false,
  actionCount = 0,
  ragUsed = false,
  ragChunkCount = 0,
  statusCode = 200,
  latencyTotalMs = null,
  latencyMiniMs = null,
  latencyNanoMs = null,
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
        model_mini: String(modelMini || "gpt-5-mini"),
        model_nano: String(modelNano || "gpt-5-nano"),
        mini_input_tokens: asIntOrZero(miniInputTokens),
        mini_output_tokens: asIntOrZero(miniOutputTokens),
        nano_input_tokens: asIntOrZero(nanoInputTokens),
        nano_output_tokens: asIntOrZero(nanoOutputTokens),
        action_used: Boolean(actionUsed),
        action_count: asIntOrZero(actionCount),
        rag_used: Boolean(ragUsed),
        rag_chunk_count: asIntOrZero(ragChunkCount),
        status_code: asIntOrZero(statusCode || 200) || 200,
        latency_total_ms: asNullableInt(latencyTotalMs),
        latency_mini_ms: asNullableInt(latencyMiniMs),
        latency_nano_ms: asNullableInt(latencyNanoMs),
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

module.exports = {
  saveMessageAnalytics,
};
