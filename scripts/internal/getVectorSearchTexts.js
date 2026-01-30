async function getVectorSearchTexts({ supId, supKey, agentId, embedding }) {
  if (!supId || !supKey) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }

  const baseUrl = `https://${supId}.supabase.co/rest/v1`;

  let response;
  try {
    response = await fetch(`${baseUrl}/rpc/vector_search_texts`, {
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
  } catch (error) {
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
  } catch (error) {
    return {
      ok: false,
      status: 502,
      error: "Vector search unavailable",
    };
  }

  const chunks = Array.isArray(payload) ? payload : payload?.chunks ?? payload;

  return {
    ok: true,
    chunks,
  };
}

module.exports = {
  getVectorSearchTexts,
};
