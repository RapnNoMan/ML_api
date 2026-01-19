const { validateAgentKey } = require("../../scripts/internal/validateAgentKey");

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

  res.status(200).json({
    ...body,
  });
};
