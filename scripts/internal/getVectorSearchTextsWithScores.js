function toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function clampScore(value) {
  const num = toFiniteNumber(value);
  if (num === null) return null;
  if (num < 0) return 0;
  if (num > 1) return 1;
  return num;
}

function normalizeRow(row) {
  const chunkText = String(
    row?.chunk_text ?? row?.chunkText ?? row?.text ?? row?.document ?? ""
  ).trim();
  if (!chunkText) return null;

  const distance = toFiniteNumber(row?.distance);
  const score =
    clampScore(row?.score ?? row?.similarity) ??
    (distance === null ? null : clampScore(1 - distance));

  return {
    chunk_text: chunkText,
    distance,
    score,
  };
}

async function getVectorSearchTextsWithScores({ supId, supKey, agentId, embedding }) {
  if (!supId || !supKey) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }

  const baseUrl = `https://${supId}.supabase.co/rest/v1`;

  let response;
  try {
    response = await fetch(`${baseUrl}/rpc/vector_search_texts_scored`, {
      method: "POST",
      headers: {
        apikey: supKey,
        Authorization: `Bearer ${supKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        p_agent_id: agentId,
        p_query_embedding: embedding,
      }),
    });
  } catch (_) {
    return {
      ok: false,
      status: 502,
      error: "Vector search unavailable",
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: 502,
      error: "Vector search unavailable",
    };
  }

  let payload;
  try {
    payload = await response.json();
  } catch (_) {
    return {
      ok: false,
      status: 502,
      error: "Vector search unavailable",
    };
  }

  const rawItems = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.items)
      ? payload.items
      : Array.isArray(payload?.chunks)
        ? payload.chunks
        : [];
  const items = rawItems.map(normalizeRow).filter(Boolean);

  return {
    ok: true,
    items,
    chunks: items.map((item) => item.chunk_text),
  };
}

module.exports = {
  getVectorSearchTextsWithScores,
};
