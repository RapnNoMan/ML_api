function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getBaseUrl(req) {
  const forwardedProto = String(req?.headers?.["x-forwarded-proto"] || "").trim();
  const host = String(req?.headers?.host || "").trim();
  const proto = forwardedProto || (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

async function readJsonBody(req) {
  if (req?.body && typeof req.body === "object") return req.body;
  if (typeof req?.body === "string" && req.body.trim()) {
    try {
      return JSON.parse(req.body);
    } catch (_) {
      return {};
    }
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

async function createSonioxTemporaryKey() {
  if (!process.env.SONIOX_API_KEY) {
    return { ok: false, status: 500, error: "Missing SONIOX_API_KEY" };
  }

  let response;
  try {
    response = await fetch("https://api.soniox.com/v1/auth/temporary-api-key", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.SONIOX_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        usage_type: "transcribe_websocket",
        expires_in_seconds: 300,
        client_reference_id: "chatdemo",
      }),
    });
  } catch (_) {
    return { ok: false, status: 502, error: "Soniox temporary key request failed" };
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch (_) {}

  if (!response.ok) {
    return {
      ok: false,
      status: response.status || 502,
      error: payload?.message || payload?.error || "Soniox temporary key request failed",
    };
  }

  return {
    ok: true,
    api_key: payload?.api_key || null,
    expires_at: payload?.expires_at || null,
  };
}

async function proxyWidgetTurn({ baseUrl, agentId, transcript, anonId, chatId }) {
  if (!agentId) return { ok: false, status: 400, error: "Missing agent_id" };
  if (!transcript) return { ok: false, status: 400, error: "Missing transcript" };
  if (!anonId || !chatId) return { ok: false, status: 400, error: "Missing chat identity" };

  let response;
  try {
    response = await fetch(`${baseUrl}/api/v1/widget/${encodeURIComponent(agentId)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://app.mitsolab.com",
        Referer: "https://app.mitsolab.com/widget",
      },
      body: JSON.stringify({
        message: transcript,
        anon_id: anonId,
        chat_id: chatId,
      }),
    });
  } catch (_) {
    return { ok: false, status: 502, error: "Widget turn request failed" };
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch (_) {}

  if (!response.ok) {
    return {
      ok: false,
      status: response.status || 502,
      error: payload?.error || "Widget turn failed",
      details: payload || null,
    };
  }

  return {
    ok: true,
    reply: String(payload?.reply || "").trim(),
    raw: payload || null,
  };
}

async function requestHamsaTts({ text, speaker = "Hady", dialect = "jor" }) {
  if (!process.env.HAMSA_API_KEY) {
    return { ok: false, status: 500, error: "Missing HAMSA_API_KEY" };
  }
  const trimmedText = String(text || "").trim();
  if (!trimmedText) return { ok: false, status: 400, error: "Missing text" };

  async function doRequest(speakerName) {
    try {
      return await fetch("https://api.tryhamsa.com/v1/realtime/tts", {
        method: "POST",
        headers: {
          Authorization: `Token ${process.env.HAMSA_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: trimmedText,
          speaker: speakerName,
          dialect,
          mulaw: false,
        }),
      });
    } catch (_) {
      return null;
    }
  }

  let response = await doRequest(speaker);
  let usedSpeaker = speaker;
  if (!response || !response.ok) {
    response = await doRequest("Jasem");
    usedSpeaker = "Jasem";
  }

  if (!response) {
    return { ok: false, status: 502, error: "Hamsa TTS request failed" };
  }

  if (!response.ok) {
    let errText = "";
    try {
      errText = await response.text();
    } catch (_) {}
    return {
      ok: false,
      status: response.status || 502,
      error: errText || "Hamsa TTS request failed",
    };
  }

  let arrayBuffer;
  try {
    arrayBuffer = await response.arrayBuffer();
  } catch (_) {
    return { ok: false, status: 502, error: "Failed to read Hamsa audio response" };
  }

  return {
    ok: true,
    audio: Buffer.from(arrayBuffer),
    contentType: String(response.headers.get("content-type") || "audio/wav"),
    speaker: usedSpeaker,
  };
}

function renderPage(agentId) {
  const safeAgentId = escapeHtml(agentId || "");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>Call Demo</title>
    <style>
      :root {
        --bg: #08131a;
        --panel: rgba(10, 24, 32, 0.92);
        --panel-border: rgba(108, 214, 255, 0.16);
        --ink: #eef7fb;
        --muted: #92a9b5;
        --line: rgba(255,255,255,0.08);
        --accent: #68d7ff;
        --accent-2: #16b9b2;
        --user: #113649;
        --assistant: #16242f;
        --danger: #ff7b7b;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        color: var(--ink);
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
        background:
          radial-gradient(circle at top, rgba(22, 185, 178, 0.18), transparent 36%),
          radial-gradient(circle at bottom, rgba(104, 215, 255, 0.18), transparent 30%),
          linear-gradient(180deg, #061018 0%, #08131a 100%);
      }
      .shell {
        width: min(100%, 760px);
        margin: 0 auto;
        padding: 16px 16px 28px;
      }
      .panel {
        background: var(--panel);
        border: 1px solid var(--panel-border);
        border-radius: 24px;
        box-shadow: 0 18px 60px rgba(0, 0, 0, 0.28);
        backdrop-filter: blur(18px);
      }
      .panel {
        padding: 14px;
      }
      .stage {
        display: grid;
        gap: 12px;
      }
      .status {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: center;
        padding: 12px 14px;
        border-radius: 18px;
        background: rgba(255,255,255,0.04);
        border: 1px solid var(--line);
      }
      .status strong {
        display: block;
        font-size: 14px;
      }
      .status span {
        display: block;
        margin-top: 3px;
        color: var(--muted);
        font-size: 12px;
      }
      .meter {
        min-width: 74px;
        text-align: right;
        color: var(--accent);
        font-size: 12px;
      }
      .controls {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
      }
      button {
        border: 0;
        border-radius: 18px;
        padding: 16px 18px;
        font-size: 15px;
        font-weight: 700;
        cursor: pointer;
      }
      .primary {
        background: linear-gradient(135deg, var(--accent), var(--accent-2));
        color: #041117;
      }
      .secondary {
        background: rgba(255,255,255,0.05);
        color: var(--ink);
        border: 1px solid var(--line);
      }
      button:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .livebox {
        min-height: 84px;
        padding: 14px;
        border-radius: 18px;
        background: rgba(255,255,255,0.03);
        border: 1px solid var(--line);
      }
      .label {
        font-size: 11px;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .livetext {
        margin-top: 8px;
        font-size: 18px;
        line-height: 1.45;
        min-height: 44px;
      }
      .chat {
        display: grid;
        gap: 10px;
        max-height: 44vh;
        overflow: auto;
        padding-right: 2px;
      }
      .msg {
        border-radius: 18px;
        padding: 12px 14px;
        border: 1px solid var(--line);
      }
      .msg.user { background: var(--user); }
      .msg.assistant { background: var(--assistant); }
      .msg .who {
        font-size: 11px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--muted);
        margin-bottom: 6px;
      }
      .msg .text {
        white-space: pre-wrap;
        line-height: 1.55;
        font-size: 15px;
      }
      .debugbox {
        min-height: 120px;
        max-height: 24vh;
        overflow: auto;
        padding: 14px;
        border-radius: 18px;
        background: rgba(255,255,255,0.03);
        border: 1px solid var(--line);
        font-size: 12px;
        line-height: 1.5;
        color: var(--muted);
        white-space: pre-wrap;
      }
      .error { color: var(--danger); }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="panel stage">
        <div class="status">
          <div>
            <strong id="statusTitle">Idle</strong>
            <span id="statusDetail">Tap start, allow microphone access, and speak in Arabic or English.</span>
          </div>
          <div class="meter" id="voiceMeter">quiet</div>
        </div>
        <div class="controls">
          <button class="primary" id="startBtn">Start Listening</button>
          <button class="secondary" id="stopBtn" disabled>Stop</button>
        </div>
        <div class="livebox">
          <div class="label">Live Transcript</div>
          <div class="livetext" id="liveTranscript">...</div>
        </div>
        <div class="chat" id="chat"></div>
        <div class="livebox">
          <div class="label">Debug</div>
          <div class="debugbox" id="debugLog">Ready.\nAgent ID: ${safeAgentId || "(missing)"}</div>
        </div>
      </section>
    </main>
    <script type="module">
      import { SonioxClient } from "https://esm.sh/@soniox/client?bundle";

      const agentId = new URLSearchParams(window.location.search).get("agent_id") || "${safeAgentId}";
      const endpoint = "/api/chatdemo";
      const statusTitle = document.getElementById("statusTitle");
      const statusDetail = document.getElementById("statusDetail");
      const voiceMeter = document.getElementById("voiceMeter");
      const liveTranscript = document.getElementById("liveTranscript");
      const chat = document.getElementById("chat");
      const debugLog = document.getElementById("debugLog");
      const startBtn = document.getElementById("startBtn");
      const stopBtn = document.getElementById("stopBtn");

      function debug(message, extra = null) {
        try {
          const now = new Date();
          const stamp = now.toLocaleTimeString("en-GB", { hour12: false });
          const suffix =
            extra === null || extra === undefined
              ? ""
              : typeof extra === "string"
                ? " | " + extra
                : " | " + JSON.stringify(extra);
          const line = "[" + stamp + "] " + message + suffix;
          if (debugLog) {
            debugLog.textContent = line + "\n" + debugLog.textContent;
          }
          console.log(line);
        } catch (error) {
          console.error("debug log failed", error);
        }
      }

      if (!agentId) {
        statusTitle.textContent = "Missing agent";
        statusDetail.textContent = "Open /chatdemo?agent_id=YOUR_AGENT_ID";
        startBtn.disabled = true;
        debug("Missing agent_id in URL");
      }

      const anonStorageKey = "chatdemo:anon:" + agentId;
      const chatStorageKey = "chatdemo:chat:" + agentId;
      let anonId = localStorage.getItem(anonStorageKey);
      let chatId = localStorage.getItem(chatStorageKey);
      if (!anonId) {
        anonId = (globalThis.crypto?.randomUUID?.() || ("anon-" + Date.now()));
        localStorage.setItem(anonStorageKey, anonId);
      }
      if (!chatId) {
        chatId = (globalThis.crypto?.randomUUID?.() || ("chat-" + Date.now()));
        localStorage.setItem(chatStorageKey, chatId);
      }

      async function fetchSonioxTemporaryKey() {
        debug("Requesting Soniox temporary key");
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "soniox_temp_key" }),
        });
        const payload = await response.json();
        if (!response.ok || !payload?.api_key) {
          debug("Soniox key request failed", payload?.error || response.status);
          throw new Error(payload?.error || "Failed to obtain Soniox key");
        }
        debug("Soniox temporary key received");
        return payload.api_key;
      }

      const sonioxClient = new SonioxClient({
        api_key: fetchSonioxTemporaryKey,
      });

      let recording = null;
      let finalizedText = "";
      let latestTranscript = "";
      let lastSubmittedTranscript = "";
      let activeAudio = null;
      let activeTurnController = null;
      let ttsController = null;
      let isAssistantSpeaking = false;
      let isProcessingTurn = false;
      let pendingFinalize = false;

      function setStatus(title, detail, meter = "") {
        statusTitle.textContent = title;
        statusDetail.textContent = detail;
        voiceMeter.textContent = meter || "";
      }

      function pushMessage(role, text) {
        const item = document.createElement("article");
        item.className = "msg " + role;
        item.innerHTML = '<div class="who">' + (role === "user" ? "You" : "Agent") + '</div><div class="text"></div>';
        item.querySelector(".text").textContent = text;
        chat.appendChild(item);
        chat.scrollTop = chat.scrollHeight;
      }

      function stopPlayback() {
        isAssistantSpeaking = false;
        if (activeAudio) {
          try { activeAudio.pause(); } catch {}
          if (activeAudio.src && activeAudio.src.startsWith("blob:")) {
            URL.revokeObjectURL(activeAudio.src);
          }
          activeAudio = null;
        }
      }

      function interruptAssistant(reason = "Interrupted") {
        debug("Assistant interrupted", reason);
        stopPlayback();
        if (activeTurnController) {
          try { activeTurnController.abort(); } catch {}
          activeTurnController = null;
        }
        if (ttsController) {
          try { ttsController.abort(); } catch {}
          ttsController = null;
        }
        if (!isProcessingTurn) {
          setStatus("Listening", reason, "barge-in");
        }
      }

      async function synthesizeAndPlay(text) {
        ttsController = new AbortController();
        debug("Sending text to Hamsa TTS", text.slice(0, 120));
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "tts", text }),
          signal: ttsController.signal,
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          debug("Hamsa TTS failed", payload?.error || response.status);
          throw new Error(payload?.error || "TTS failed");
        }
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        activeAudio = audio;
        isAssistantSpeaking = true;
        debug("Playing Hamsa audio", response.headers.get("content-type") || "audio/wav");
        setStatus("Speaking", "Playing Hamsa voice reply.", "voice");
        await new Promise((resolve, reject) => {
          audio.onended = () => {
            isAssistantSpeaking = false;
            URL.revokeObjectURL(url);
            activeAudio = null;
            debug("Audio playback finished");
            resolve();
          };
          audio.onerror = () => {
            isAssistantSpeaking = false;
            URL.revokeObjectURL(url);
            activeAudio = null;
            debug("Audio playback error");
            reject(new Error("Audio playback failed"));
          };
          audio.play().catch(reject);
        });
      }

      async function submitTurn(text) {
        const transcript = String(text || "").trim();
        if (!transcript || transcript === lastSubmittedTranscript || isProcessingTurn) return;
        lastSubmittedTranscript = transcript;
        isProcessingTurn = true;
        activeTurnController = new AbortController();
        pushMessage("user", transcript);
        debug("Submitting transcript", transcript);
        liveTranscript.textContent = "...";
        setStatus("Thinking", "Sending transcript to the backend agent flow.", "llm");

        try {
          const response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "turn",
              agent_id: agentId,
              transcript,
              anon_id: anonId,
              chat_id: chatId,
            }),
            signal: activeTurnController.signal,
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok || !payload?.reply) {
            debug("Agent turn failed", payload?.error || response.status);
            throw new Error(payload?.error || "Agent turn failed");
          }
          debug("Agent reply received", payload.reply.slice(0, 160));
          pushMessage("assistant", payload.reply);
          await synthesizeAndPlay(payload.reply);
          setStatus("Listening", "Speak again whenever you want.", "ready");
        } catch (error) {
          if (error?.name === "AbortError") {
            debug("Turn aborted");
            setStatus("Listening", "Interrupted. Speak again.", "ready");
            return;
          }
          debug("Turn error", String(error?.message || error || "Unknown error"));
          setStatus("Error", String(error?.message || error || "Unknown error"), "retry");
          if (debugLog) debugLog.classList.add("error");
        } finally {
          isProcessingTurn = false;
          activeTurnController = null;
          ttsController = null;
        }
      }

      async function startRecording() {
        if (!agentId || recording) return;
        setStatus("Starting", "Opening microphone and Soniox session.", "...");
        if (debugLog) debugLog.classList.remove("error");
        debug("Starting Soniox recording session");
        finalizedText = "";
        latestTranscript = "";
        pendingFinalize = false;

        recording = sonioxClient.realtime.record({
          model: "stt-rt-v4",
          language_hints: ["ar", "en"],
          enable_language_identification: true,
          enable_endpoint_detection: true,
          max_endpoint_delay_ms: 900,
          auto_reconnect: true,
          max_reconnect_attempts: 3,
          reconnect_base_delay_ms: 1000,
        });

        recording.on("connected", () => {
          startBtn.disabled = true;
          stopBtn.disabled = false;
          debug("Soniox connected");
          setStatus("Listening", "Speak in Arabic or English. Pause to send your turn.", "live");
        });

        recording.on("result", (result) => {
          const tokens = Array.isArray(result?.tokens) ? result.tokens : [];
          latestTranscript = tokens.map((token) => String(token?.text || "")).join("").trim();
          if (latestTranscript) {
            liveTranscript.textContent = latestTranscript;
            voiceMeter.textContent = "hearing";
            if (isAssistantSpeaking || isProcessingTurn) {
              interruptAssistant("You started talking, so I stopped the reply.");
            }
          }
        });

        recording.on("endpoint", async () => {
          if (!recording) return;
          pendingFinalize = true;
          debug("Endpoint detected");
          setStatus("Endpoint", "You paused. Finalizing the utterance.", "...");
          try {
            await recording.finalize();
          } catch (_) {}
        });

        recording.on("finalized", async () => {
          if (!pendingFinalize) return;
          pendingFinalize = false;
          const transcript = latestTranscript;
          latestTranscript = "";
          finalizedText = "";
          debug("Transcript finalized", transcript || "(empty)");
          await submitTurn(transcript);
        });

        recording.on("error", (error) => {
          debug("Soniox recording error", String(error?.message || error || "Unknown error"));
          setStatus("Error", String(error?.message || error || "Recording error"), "!");
          if (debugLog) debugLog.classList.add("error");
          recording = null;
          startBtn.disabled = false;
          stopBtn.disabled = true;
        });

        recording.on("reconnecting", ({ attempt, max_attempts, delay_ms }) => {
          debug("Soniox reconnecting", { attempt, max_attempts, delay_ms });
        });

        recording.on("reconnected", (event) => {
          debug("Soniox reconnected", event || "ok");
        });

        recording.on("state_change", ({ new_state }) => {
          debug("State changed", new_state);
          if (new_state === "recording") {
            voiceMeter.textContent = "live";
          } else if (new_state === "reconnecting") {
            setStatus("Reconnecting", "Soniox connection dropped. Recovering.", "...");
          }
        });
      }

      async function stopRecording() {
        if (!recording) return;
        debug("Stopping recording");
        try {
          await recording.stop();
        } catch (_) {}
        recording = null;
        startBtn.disabled = false;
        stopBtn.disabled = true;
        stopPlayback();
        setStatus("Stopped", "Microphone closed.", "off");
      }

      startBtn.addEventListener("click", () => {
        startRecording().catch((error) => {
          debug("Start failed", String(error?.message || error || "Failed to start"));
          if (debugLog) debugLog.classList.add("error");
          setStatus("Error", String(error?.message || error || "Failed to start"), "!");
        });
      });

      stopBtn.addEventListener("click", () => {
        stopRecording().catch(() => {});
      });
    </script>
  </body>
</html>`;
}

module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    const agentId = String(req?.query?.agent_id || "").trim();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(renderPage(agentId));
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const body = await readJsonBody(req);
  const action = String(body?.action || "").trim();

  if (action === "soniox_temp_key") {
    const result = await createSonioxTemporaryKey();
    res.status(result.status || (result.ok ? 200 : 500)).json(result);
    return;
  }

  if (action === "turn") {
    const baseUrl = getBaseUrl(req);
    const result = await proxyWidgetTurn({
      baseUrl,
      agentId: String(body?.agent_id || "").trim(),
      transcript: String(body?.transcript || "").trim(),
      anonId: String(body?.anon_id || "").trim(),
      chatId: String(body?.chat_id || "").trim(),
    });
    res.status(result.status || (result.ok ? 200 : 500)).json(result);
    return;
  }

  if (action === "tts") {
    const result = await requestHamsaTts({
      text: String(body?.text || ""),
      speaker: "Hady",
      dialect: "jor",
    });
    if (!result.ok) {
      res.status(result.status || 500).json({ error: result.error });
      return;
    }
    res.setHeader("Content-Type", result.contentType || "audio/wav");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(result.audio);
    return;
  }

  res.status(400).json({ error: "Invalid action" });
};
