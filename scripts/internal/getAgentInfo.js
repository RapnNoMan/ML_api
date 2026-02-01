async function getAgentInfo({ supId, supKey, agentId }) {
  if (!supId || !supKey) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }

  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  const url = `${baseUrl}/agents?select=name,role,policies&id=eq.${agentId}&limit=1`;

  let response;
  try {
    response = await fetch(url, {
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
      error: "Agent service unavailable",
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: 502,
      error: "Agent service unavailable",
    };
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    return {
      ok: false,
      status: 502,
      error: "Agent service unavailable",
    };
  }

  const agent = Array.isArray(payload) ? payload[0] : payload;
  if (!agent) {
    return { ok: false, status: 404, error: "Agent not found" };
  }

  return {
    ok: true,
    name: agent.name ?? "",
    role: agent.role ?? "",
    policies: agent.policies ?? [],
  };
}

module.exports = {
  getAgentInfo,
};
