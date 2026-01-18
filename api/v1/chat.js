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

  if (token !== "key_333") {
    res.status(401).json({ error: "Invalid API key" });
    return;
  }

  res.status(200).json(body);
};
