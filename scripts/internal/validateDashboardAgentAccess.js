async function validateDashboardAgentAccess({ supId, supKey, agentId, userId, email }) {
  if (!supId || !supKey) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }

  const normalizedUserId = String(userId || "").trim();
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedUserId || !normalizedEmail) {
    return { ok: false, status: 400, error: "Missing dashboard identity" };
  }

  const baseUrl = `https://${supId}.supabase.co/rest/v1`;

  let agentRows;
  try {
    const agentParams = new URLSearchParams({
      select: "owner_id,workspace_id",
      id: `eq.${agentId}`,
      limit: "1",
    });
    const agentResponse = await fetch(`${baseUrl}/agents?${agentParams.toString()}`, {
      method: "GET",
      headers: {
        apikey: supKey,
        Authorization: `Bearer ${supKey}`,
        Accept: "application/json",
      },
    });

    if (!agentResponse.ok) {
      return {
        ok: false,
        status: 502,
        error: "Authorization service unavailable",
      };
    }

    agentRows = await agentResponse.json();
  } catch (_) {
    return {
      ok: false,
      status: 502,
      error: "Authorization service unavailable",
    };
  }

  const agent = Array.isArray(agentRows) ? agentRows[0] : null;
  if (!agent) {
    return { ok: false, status: 401, error: "Agent not found" };
  }

  const ownerId = String(agent?.owner_id || "").trim();
  if (ownerId && ownerId === normalizedUserId) {
    return { ok: true };
  }

  const workspaceId = String(agent?.workspace_id || "").trim();
  if (!workspaceId) {
    return { ok: false, status: 403, error: "Unauthorized" };
  }

  let workspaceRows;
  try {
    const workspaceParams = new URLSearchParams({
      select: "shared_emails",
      id: `eq.${workspaceId}`,
      limit: "1",
    });
    const workspaceResponse = await fetch(`${baseUrl}/workspace?${workspaceParams.toString()}`, {
      method: "GET",
      headers: {
        apikey: supKey,
        Authorization: `Bearer ${supKey}`,
        Accept: "application/json",
      },
    });

    if (!workspaceResponse.ok) {
      return {
        ok: false,
        status: 502,
        error: "Authorization service unavailable",
      };
    }

    workspaceRows = await workspaceResponse.json();
  } catch (_) {
    return {
      ok: false,
      status: 502,
      error: "Authorization service unavailable",
    };
  }

  const workspace = Array.isArray(workspaceRows) ? workspaceRows[0] : null;
  const sharedEmails = Array.isArray(workspace?.shared_emails)
    ? workspace.shared_emails
        .map((value) => String(value || "").trim().toLowerCase())
        .filter(Boolean)
    : [];

  if (sharedEmails.includes(normalizedEmail)) {
    return { ok: true };
  }

  return { ok: false, status: 403, error: "Unauthorized" };
}

module.exports = {
  validateDashboardAgentAccess,
};
