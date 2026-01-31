const { validateAgentKey } = require("../../scripts/internal/validateAgentKey");
const { checkMessageCap } = require("../../scripts/internal/checkMessageCap");
const { SKIP_VECTOR_MESSAGES } = require("../../scripts/internal/skipVectorMessages");
const { getMessageEmbedding } = require("../../scripts/internal/getMessageEmbedding");
const { getVectorSearchTexts } = require("../../scripts/internal/getVectorSearchTexts");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const body = req.body ?? {};
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";
  const missing = [];
  if (!token) missing.push("authorization");
  if (!body.agent_id) missing.push("agent_id");
  if (!body.message) missing.push("message");

  if (missing.length > 0) {
    res.status(400).json({
      error: "Missing required fields",
      missing,
    });
    return;
  }

  const validation = await validateAgentKey({
    supId: process.env.SUP_ID,
    supKey: process.env.SUP_KEY,
    agentId: body.agent_id,
    token,
  });
  if (!validation.ok) {
    res.status(validation.status).json({ error: validation.error });
    return;
  }

  const usageCheck = await checkMessageCap({
    supId: process.env.SUP_ID,
    supKey: process.env.SUP_KEY,
    agentId: body.agent_id,
  });
  if (!usageCheck.ok) {
    res.status(usageCheck.status).json({ error: usageCheck.error });
    return;
  }

  const normalizedMessage = String(body.message)
    .trim()
    .toLowerCase()
    .replace(/^[\s"'`.,!?(){}\[\]<>-]+|[\s"'`.,!?(){}\[\]<>-]+$/g, "")
    .replace(/\s+/g, " ");
  if (!normalizedMessage || SKIP_VECTOR_MESSAGES.has(normalizedMessage)) {
    res.status(200).json([]);
    return;
  }

  const embeddingResult = await getMessageEmbedding({
    apiKey: process.env.OPENAI_API_KEY,
    message: body.message,
  });
  if (!embeddingResult.ok) {
    res.status(embeddingResult.status).json({ error: embeddingResult.error });
    return;
  }

  const vectorResult = await getVectorSearchTexts({
    supId: process.env.SUP_ID,
    supKey: process.env.SUP_KEY,
    agentId: body.agent_id,
    embedding: embeddingResult.embedding,
  });
  if (!vectorResult.ok) {
    res.status(vectorResult.status).json({ error: vectorResult.error });
    return;
  }

  res.status(200).json(vectorResult.chunks);
};
