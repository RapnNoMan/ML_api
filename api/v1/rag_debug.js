const { validateAgentKey } = require("../../scripts/internal/validateAgentKey");
const { checkMessageCap } = require("../../scripts/internal/checkMessageCap");
const { SKIP_VECTOR_MESSAGES } = require("../../scripts/internal/skipVectorMessages");
const { getRelevantKnowledgeChunks } = require("../../scripts/internal/getRelevantKnowledgeChunks");
const { randomBytes } = require("node:crypto");

function normalizeIdValue(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function makeGeneratedId() {
  return randomBytes(12).toString("hex");
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

module.exports = async function handler(req, res) {
  try {
    setCorsHeaders(res);
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const requestStartedAt = Date.now();
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
      res.status(400).json({ error: "Missing required fields", missing });
      return;
    }

    const incomingAnonId = normalizeIdValue(body.anon_id);
    const incomingChatId = normalizeIdValue(body.chat_id);
    let anonId = incomingAnonId;
    let chatId = incomingChatId;
    if (!anonId && !chatId) {
      const sessionId = makeGeneratedId();
      anonId = sessionId;
      chatId = sessionId;
    } else if (!anonId) {
      anonId = makeGeneratedId();
    } else if (!chatId) {
      chatId = makeGeneratedId();
    }

    const [validation, usageCheck] = await Promise.all([
      validateAgentKey({
        supId: process.env.SUP_ID,
        supKey: process.env.SUP_KEY,
        agentId: body.agent_id,
        token,
      }),
      checkMessageCap({
        supId: process.env.SUP_ID,
        supKey: process.env.SUP_KEY,
        agentId: body.agent_id,
      }),
    ]);
    if (!validation.ok) {
      res.status(validation.status).json({ error: validation.error });
      return;
    }
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
      res.status(200).json({
        message: String(body.message),
        skipped: true,
        reason: "skip_vector_message",
        finalChunks: [],
        debug: null,
        totalMs: Date.now() - requestStartedAt,
      });
      return;
    }

    const ragResult = await getRelevantKnowledgeChunks({
      supId: process.env.SUP_ID,
      supKey: process.env.SUP_KEY,
      voyageApiKey: process.env.VOYAGE_API_KEY,
      outputDimension: process.env.VOYAGE_OUTPUT_DIMENSION,
      agentId: body.agent_id,
      anonId,
      chatId,
      message: body.message,
    });
    if (!ragResult.ok) {
      res.status(ragResult.status).json({ error: ragResult.error });
      return;
    }

    res.status(200).json({
      message: String(body.message),
      skipped: false,
      finalChunks: Array.isArray(ragResult.chunks) ? ragResult.chunks : [],
      debug: ragResult.debug ?? null,
      totalMs: Date.now() - requestStartedAt,
    });
  } catch (error) {
    res.status(500).json({
      error: "Server error",
      detail: String(error?.message || error || "Unknown error"),
      stack: typeof error?.stack === "string" ? error.stack : null,
    });
  }
};
