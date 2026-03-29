async function getVoyageMessageEmbedding({
  apiKey,
  message,
  model = "voyage-4-lite",
  inputType = "query",
  outputDimension,
}) {
  if (!apiKey) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }

  const payload = {
    input: String(message ?? ""),
    model,
    input_type: inputType,
  };
  if (Number.isFinite(Number(outputDimension)) && Number(outputDimension) > 0) {
    payload.output_dimension = Number(outputDimension);
  }

  let response;
  try {
    response = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (_) {
    return {
      ok: false,
      status: 502,
      error: "Embedding service unavailable",
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: 502,
      error: "Embedding service unavailable",
    };
  }

  let body;
  try {
    body = await response.json();
  } catch (_) {
    return {
      ok: false,
      status: 502,
      error: "Embedding service unavailable",
    };
  }

  const embedding = body?.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.length === 0) {
    return {
      ok: false,
      status: 502,
      error: "Embedding service unavailable",
    };
  }

  return {
    ok: true,
    embedding,
    usage: {
      total_tokens: Number(body?.usage?.total_tokens || body?.total_tokens || 0),
    },
  };
}

module.exports = {
  getVoyageMessageEmbedding,
};
