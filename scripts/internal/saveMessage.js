async function saveMessage({
  supId,
  supKey,
  agentId,
  workspaceId,
  anonId,
  chatId,
  country,
  prompt,
  result,
  source = "api",
  action = false,
}) {
  if (!supId || !supKey) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }

  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  const url = `${baseUrl}/messages`;

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        apikey: supKey,
        Authorization: `Bearer ${supKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        agent_id: agentId,
        workspace_id: workspaceId ?? null,
        annon: anonId,
        chat_id: chatId,
        country: country ?? null,
        prompt: typeof prompt === "string" ? prompt : String(prompt ?? ""),
        result: typeof result === "string" ? result : String(result ?? ""),
        source: source || "api",
        action: Boolean(action),
      }),
    });
  } catch (error) {
    return { ok: false, status: 502, error: "Message service unavailable" };
  }

  if (!response.ok) {
    return { ok: false, status: 502, error: "Message service unavailable" };
  }

  return { ok: true };
}

module.exports = {
  saveMessage,
};
