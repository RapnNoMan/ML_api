async function rerankVoyageDocuments({
  apiKey,
  query,
  documents,
  model = "rerank-2.5-lite",
  topK = 5,
}) {
  if (!apiKey) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }

  const safeDocuments = (Array.isArray(documents) ? documents : [])
    .map((document) => String(document ?? "").trim())
    .filter(Boolean);
  if (safeDocuments.length === 0) {
    return { ok: true, results: [] };
  }

  let response;
  try {
    response = await fetch("https://api.voyageai.com/v1/rerank", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: String(query ?? ""),
        documents: safeDocuments,
        model,
        top_k: topK,
      }),
    });
  } catch (_) {
    return {
      ok: false,
      status: 502,
      error: "Rerank service unavailable",
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: 502,
      error: "Rerank service unavailable",
    };
  }

  let body;
  try {
    body = await response.json();
  } catch (_) {
    return {
      ok: false,
      status: 502,
      error: "Rerank service unavailable",
    };
  }

  return {
    ok: true,
    results: Array.isArray(body?.data) ? body.data : Array.isArray(body?.results) ? body.results : [],
    usage: {
      total_tokens: Number(body?.usage?.total_tokens || body?.total_tokens || 0),
    },
  };
}

module.exports = {
  rerankVoyageDocuments,
};
