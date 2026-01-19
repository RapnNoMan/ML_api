async function checkMessageCap({ supId, supKey, agentId }) {
  if (!supId || !supKey) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }

  const baseUrl = `https://${supId}.supabase.co/rest/v1`;

  let response;
  try {
    response = await fetch(`${baseUrl}/rpc/get_message_usage_service`, {
      method: "POST",
      headers: {
        apikey: supKey,
        Authorization: `Bearer ${supKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ p_agent_id: agentId }),
    });
  } catch (error) {
    return {
      ok: false,
      status: 502,
      error: "Usage service unavailable",
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: 502,
      error: "Usage service unavailable",
    };
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    return {
      ok: false,
      status: 502,
      error: "Usage service unavailable",
    };
  }

  const usage = Array.isArray(payload) ? payload[0] : payload;
  const messages = Number(usage?.messages);
  const cap = Number(usage?.cap);

  if (Number.isFinite(cap) && Number.isFinite(messages) && messages >= cap) {
    return { ok: false, status: 429, error: "Message limit reached" };
  }

  return { ok: true };
}

module.exports = {
  checkMessageCap,
};
