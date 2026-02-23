async function getChatHistory({ supId, supKey, agentId, anonId, chatId, maxRows = 3 }) {
  if (!supId || !supKey) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }

  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  const url = new URL(`${baseUrl}/messages`);
  url.searchParams.set("select", "prompt,result,created_at");
  url.searchParams.set("agent_id", `eq.${agentId}`);
  url.searchParams.set("annon", `eq.${anonId}`);
  url.searchParams.set("chat_id", `eq.${chatId}`);
  url.searchParams.set("order", "created_at.desc");
  if (Number.isFinite(Number(maxRows)) && Number(maxRows) > 0) {
    url.searchParams.set("limit", String(Math.floor(Number(maxRows))));
  }

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
  const messages = [];

  for (const row of rows) {
    if (row.prompt) {
      messages.push({ role: "user", content: row.prompt });
    }
    if (row.result) {
      messages.push({ role: "assistant", content: row.result });
    }
  }

  return { ok: true, messages };
}

module.exports = {
  getChatHistory,
};
