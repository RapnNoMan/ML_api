async function getRecentUserPrompts({
  supId,
  supKey,
  agentId,
  anonId,
  chatId,
  limit = 2,
}) {
  if (!supId || !supKey) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }

  if (!anonId || !chatId) {
    return { ok: true, prompts: [] };
  }

  const maxRows = Math.max(1, Math.floor(Number(limit) || 2));
  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  const url = new URL(`${baseUrl}/messages`);
  url.searchParams.set("select", "prompt,created_at");
  url.searchParams.set("agent_id", `eq.${agentId}`);
  url.searchParams.set("annon", `eq.${anonId}`);
  url.searchParams.set("chat_id", `eq.${chatId}`);
  url.searchParams.set("order", "created_at.desc");
  url.searchParams.set("limit", String(maxRows));

  let response;
  try {
    response = await fetch(url.toString(), {
      headers: {
        apikey: supKey,
        Authorization: `Bearer ${supKey}`,
        Accept: "application/json",
      },
    });
  } catch (error) {
    return { ok: false, status: 502, error: "History service unavailable" };
  }

  if (!response.ok) {
    return { ok: false, status: 502, error: "History service unavailable" };
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    return { ok: false, status: 502, error: "History service unavailable" };
  }

  const rowsDesc = Array.isArray(payload) ? payload : [];
  const rows = [...rowsDesc].reverse();
  const prompts = [];
  for (const row of rows) {
    const text = typeof row?.prompt === "string" ? row.prompt.trim() : "";
    if (text) prompts.push(text);
  }

  return { ok: true, prompts };
}

module.exports = {
  getRecentUserPrompts,
};
