function isExpired(expiresAt) {
  if (!expiresAt) return false;
  const ts = new Date(expiresAt).getTime();
  if (!Number.isFinite(ts)) return false;
  return ts <= Date.now() + 30 * 1000;
}

async function refreshAccessToken({
  clientId,
  clientSecret,
  refreshToken,
}) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    return { ok: false, status: response.status };
  }

  const payload = await response.json();
  return {
    ok: true,
    access_token: payload.access_token,
    token_type: payload.token_type || "Bearer",
    expires_in: payload.expires_in,
  };
}

async function updateConnectionToken({ supId, supKey, agentId, accessToken, tokenType, expiresAt }) {
  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  const url = `${baseUrl}/google_gmail_connections?agent_id=eq.${agentId}`;

  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      apikey: supKey,
      Authorization: `Bearer ${supKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      access_token: accessToken,
      token_type: tokenType,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    }),
  });

  return response.ok;
}

async function deleteConnection({ supId, supKey, agentId }) {
  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  const url = `${baseUrl}/google_gmail_connections?agent_id=eq.${agentId}`;

  await fetch(url, {
    method: "DELETE",
    headers: {
      apikey: supKey,
      Authorization: `Bearer ${supKey}`,
    },
  });
}

async function ensureAccessToken({
  supId,
  supKey,
  agentId,
  clientId,
  clientSecret,
  connection,
}) {
  if (!connection?.access_token) {
    return { ok: false, error: "Missing access token" };
  }

  if (!isExpired(connection.expires_at)) {
    return {
      ok: true,
      access_token: connection.access_token,
      token_type: connection.token_type || "Bearer",
    };
  }

  if (!connection.refresh_token || !clientId || !clientSecret) {
    await deleteConnection({ supId, supKey, agentId });
    return { ok: false, error: "Token expired and cannot be refreshed" };
  }

  const refreshed = await refreshAccessToken({
    clientId,
    clientSecret,
    refreshToken: connection.refresh_token,
  });

  if (!refreshed.ok || !refreshed.access_token) {
    await deleteConnection({ supId, supKey, agentId });
    return { ok: false, error: "Token refresh failed" };
  }

  const expiresAt = refreshed.expires_in
    ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
    : null;

  await updateConnectionToken({
    supId,
    supKey,
    agentId,
    accessToken: refreshed.access_token,
    tokenType: refreshed.token_type,
    expiresAt,
  });

  return {
    ok: true,
    access_token: refreshed.access_token,
    token_type: refreshed.token_type,
  };
}

function buildRawEmail({ to, subject, body, cc, bcc }) {
  const lines = [];
  lines.push(`To: ${to}`);
  if (cc) lines.push(`Cc: ${cc}`);
  if (bcc) lines.push(`Bcc: ${bcc}`);
  lines.push(`Subject: ${subject}`);
  lines.push("MIME-Version: 1.0");
  lines.push("Content-Type: text/plain; charset=UTF-8");
  lines.push("");
  lines.push(body);
  const raw = lines.join("\r\n");
  return Buffer.from(raw).toString("base64url");
}

module.exports = {
  ensureAccessToken,
  buildRawEmail,
};
