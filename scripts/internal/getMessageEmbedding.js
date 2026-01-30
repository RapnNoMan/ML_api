async function getMessageEmbedding({ apiKey, message }) {
  if (!apiKey) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }

  let response;
  try {
    response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "text-embedding-3-large",
        input: message,
      }),
    });
  } catch (error) {
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

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    return {
      ok: false,
      status: 502,
      error: "Embedding service unavailable",
    };
  }

  const embedding = payload?.data?.[0]?.embedding;
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
  };
}

module.exports = {
  getMessageEmbedding,
};
