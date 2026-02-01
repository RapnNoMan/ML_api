const { validateAgentKey } = require("../../scripts/internal/validateAgentKey");
const { checkMessageCap } = require("../../scripts/internal/checkMessageCap");
const { SKIP_VECTOR_MESSAGES } = require("../../scripts/internal/skipVectorMessages");
const { getMessageEmbedding } = require("../../scripts/internal/getMessageEmbedding");
const { getVectorSearchTexts } = require("../../scripts/internal/getVectorSearchTexts");
const { getAgentInfo } = require("../../scripts/internal/getAgentInfo");
const { getAgentActionsPromptBlock } = require("../../scripts/internal/getAgentActionsPromptBlock");
const { getChatHistory } = require("../../scripts/internal/getChatHistory");
const { getChatCompletion } = require("../../scripts/internal/getChatCompletion");

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
  let vectorResult = { ok: true, chunks: [] };
  if (normalizedMessage && !SKIP_VECTOR_MESSAGES.has(normalizedMessage)) {
    const embeddingResult = await getMessageEmbedding({
      apiKey: process.env.OPENAI_API_KEY,
      message: body.message,
    });
    if (!embeddingResult.ok) {
      res.status(embeddingResult.status).json({ error: embeddingResult.error });
      return;
    }

    vectorResult = await getVectorSearchTexts({
      supId: process.env.SUP_ID,
      supKey: process.env.SUP_KEY,
      agentId: body.agent_id,
      embedding: embeddingResult.embedding,
    });
    if (!vectorResult.ok) {
      res.status(vectorResult.status).json({ error: vectorResult.error });
      return;
    }
  }

  const agentInfo = await getAgentInfo({
    supId: process.env.SUP_ID,
    supKey: process.env.SUP_KEY,
    agentId: body.agent_id,
  });
  if (!agentInfo.ok) {
    res.status(agentInfo.status).json({ error: agentInfo.error });
    return;
  }

  const actionsBlock = await getAgentActionsPromptBlock({
    supId: process.env.SUP_ID,
    supKey: process.env.SUP_KEY,
    agentId: body.agent_id,
  });
  if (!actionsBlock.ok) {
    res.status(actionsBlock.status).json({ error: actionsBlock.error });
    return;
  }

  const profileLines = [];
  if (agentInfo.name) profileLines.push(`name: ${agentInfo.name}`);
  if (agentInfo.role) profileLines.push(`role: ${agentInfo.role}`);
  if (Array.isArray(agentInfo.policies) && agentInfo.policies.length > 0) {
    profileLines.push(`policies: ${agentInfo.policies.join(" | ")}`);
  }

  const promptSections = [];
  if (profileLines.length > 0) {
    promptSections.push(["AGENT PROFILE", ...profileLines].join("\n"));
  }
  if (Array.isArray(actionsBlock.actions) && actionsBlock.actions.length > 0) {
    promptSections.push(["ACTIONS", JSON.stringify(actionsBlock.actions, null, 2)].join("\n"));
  }
  if (Array.isArray(vectorResult.chunks) && vectorResult.chunks.length > 0) {
    promptSections.push(["KNOWLEDGE CHUNKS", ...vectorResult.chunks].join("\n"));
  }

  const prompt = promptSections.join("\n\n");

  let historyMessages = [];
  if (body.anon_id && body.chat_id) {
    const historyResult = await getChatHistory({
      supId: process.env.SUP_ID,
      supKey: process.env.SUP_KEY,
      agentId: body.agent_id,
      anonId: body.anon_id,
      chatId: body.chat_id,
    });
    if (!historyResult.ok) {
      res.status(historyResult.status).json({ error: historyResult.error });
      return;
    }
    historyMessages = historyResult.messages;
  }

  const messages = [
    ...historyMessages,
    { role: "user", content: String(body.message) },
  ];

  const completion = await getChatCompletion({
    apiKey: process.env.OPENAI_API_KEY,
    model: "gpt-5-mini",
    reasoning: { effort: "low" },
    instructions: prompt,
    messages,
  });
  if (!completion.ok) {
    res.status(completion.status).json({ error: completion.error });
    return;
  }

  res.status(200).json({
    reply: completion.data?.reply ?? "",
    action: completion.data?.mode === "action" ? completion.data?.action_calls ?? [] : [],
    input_tokens: completion.usage?.input_tokens ?? null,
    output_tokens: completion.usage?.output_tokens ?? null,
  });
};
