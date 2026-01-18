module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const body = req.body ?? {};
  const missing = [];
  if (!body.api_key) missing.push("api_key");
  if (!body.agent_id) missing.push("agent_id");

  if (missing.length > 0) {
    res.status(400).json({
      error: "Missing required fields",
      missing,
    });
    return;
  }

  res.status(200).json(body);
};
