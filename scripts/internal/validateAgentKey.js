async function validateAgentKey({ supId, supKey, agentId, token }) {
  if (!supId || !supKey) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }

  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  const params = new URLSearchParams({
    agent_id: `eq.${agentId}`,
    select: "key",
  });

  let response;
  try {
    response = await fetch(`${baseUrl}/api_keys?${params.toString()}`, {
      method: "GET",
      headers: {
        apikey: supKey,
        Authorization: `Bearer ${supKey}`,
        Accept: "application/json",
      },
    });
  } catch (error) {
    return {
      ok: false,
      status: 502,
      error: "Authorization service unavailable",
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: 502,
      error: "Authorization service unavailable",
    };
  }

  let rows;
  try {
    rows = await response.json();
  } catch (error) {
    return {
      ok: false,
      status: 502,
      error: "Authorization service unavailable",
    };
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, status: 401, error: "Agent not found" };
  }

  const storedKey = rows[0]?.key || "";
  if (storedKey !== token) {
    return { ok: false, status: 401, error: "Invalid API key" };
  }

  return { ok: true };
}

module.exports = {
  validateAgentKey,
};
