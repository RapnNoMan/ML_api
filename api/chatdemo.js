function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

function getGeminiApiKey() {
  return (
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_GENAI_API_KEY ||
    ""
  ).trim();
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
        expires_in_seconds: 1800,
        client_reference_id: "chatdemo-soniox-gemini",
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
      details: payload || null,
    };
  }

  return {
    ok: true,
    api_key: payload?.api_key || null,
    expires_at: payload?.expires_at || null,
  };
}

function renderPage(agentId) {
  const safeAgentId = escapeHtml(agentId || "");
  const browserGeminiApiKey = escapeHtml(getGeminiApiKey());
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>Soniox + Gemini Live Demo</title>
    <style>
      :root {
        --bg: #071018;
        --panel: rgba(10, 24, 32, 0.92);
        --panel-border: rgba(90, 196, 255, 0.16);
        --ink: #eef7fb;
        --muted: #91a8b6;
        --line: rgba(255,255,255,0.08);
        --accent: #6bd5ff;
        --accent-2: #18b5b4;
        --danger: #ff7b7b;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        color: var(--ink);
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
        background:
          radial-gradient(circle at top, rgba(24, 181, 180, 0.18), transparent 36%),
          radial-gradient(circle at bottom, rgba(107, 213, 255, 0.18), transparent 30%),
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
        white-space: pre-wrap;
      }
      .debugbox {
        min-height: 160px;
        max-height: 34vh;
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
            <span id="statusDetail">Soniox STT into Gemini Live audio output.</span>
          </div>
          <div class="meter" id="voiceMeter">off</div>
        </div>
        <div class="controls">
          <button class="primary" id="startBtn">Start Listening</button>
          <button class="secondary" id="stopBtn" disabled>Stop</button>
        </div>
        <div class="livebox">
          <div class="label">Live Transcript</div>
          <div class="livetext" id="liveTranscript">...</div>
        </div>
        <div class="livebox">
          <div class="label">Gemini Output Transcript</div>
          <div class="livetext" id="outputTranscript">...</div>
        </div>
        <div class="livebox">
          <div class="label">Debug</div>
          <div class="debugbox" id="debugLog">Ready.&#10;Agent ID param (ignored): ${safeAgentId || "(none)"}</div>
        </div>
      </section>
    </main>
    <script type="module">
      import { SonioxClient } from "https://esm.sh/@soniox/client?bundle";
      import { GoogleGenAI, Modality, StartSensitivity, EndSensitivity } from "https://esm.sh/@google/genai?bundle";

      const browserGeminiApiKey = "${browserGeminiApiKey}";
      const endpoint = "/api/chatdemo";
      const statusTitle = document.getElementById("statusTitle");
      const statusDetail = document.getElementById("statusDetail");
      const voiceMeter = document.getElementById("voiceMeter");
      const liveTranscript = document.getElementById("liveTranscript");
      const outputTranscript = document.getElementById("outputTranscript");
      const debugLog = document.getElementById("debugLog");
      const startBtn = document.getElementById("startBtn");
      const stopBtn = document.getElementById("stopBtn");

      let ai = null;
      let session = null;
      let recording = null;
      let speakerContext = null;
      let speakerPlaybackCursor = 0;
      let isRunning = false;
      let latestTranscript = "";
      let lastNonEmptyTranscript = "";
      let pendingTranscript = "";
      let lastSubmittedTranscript = "";
      let isGeminiSpeaking = false;
      let pendingFinalize = false;
      let isPausedForOutput = false;

      function debug(message, extra = null) {
        try {
          const stamp = new Date().toLocaleTimeString("en-GB", { hour12: false });
          const suffix =
            extra === null || extra === undefined
              ? ""
              : typeof extra === "string"
                ? " | " + extra
                : " | " + JSON.stringify(extra);
          const line = "[" + stamp + "] " + message + suffix;
          debugLog.textContent = line + "\\n" + debugLog.textContent;
          console.log(line);
        } catch (error) {
          console.error("debug log failed", error);
        }
      }

      function setStatus(title, detail, meter = "") {
        statusTitle.textContent = title;
        statusDetail.textContent = detail;
        voiceMeter.textContent = meter || "";
      }

      function bytesFromBase64(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
          bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
      }

      async function fetchSonioxTempKey() {
        debug("Requesting Soniox temporary key");
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "soniox_temp_key" }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload?.api_key) {
          debug("Soniox key request failed", payload?.error || response.status);
          throw new Error(payload?.error || "Failed to obtain Soniox key");
        }
        debug("Soniox temporary key received");
        return payload.api_key;
      }

      function getBrowserGeminiApiKey() {
        const key = String(browserGeminiApiKey || "").trim();
        if (!key) {
          throw new Error("Missing GEMINI_API_KEY in server env");
        }
        debug("Using server-rendered Gemini API key");
        return key;
      }

      async function setupSpeaker() {
        if (!speakerContext) {
          speakerContext = new AudioContext({ sampleRate: 24000 });
          speakerPlaybackCursor = speakerContext.currentTime;
        }
        if (speakerContext.state === "suspended") {
          await speakerContext.resume();
        }
      }

      async function playPcm24kBase64(base64) {
        await setupSpeaker();
        const bytes = bytesFromBase64(base64);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const sampleCount = Math.floor(bytes.byteLength / 2);
        const audioBuffer = speakerContext.createBuffer(1, sampleCount, 24000);
        const channel = audioBuffer.getChannelData(0);
        for (let i = 0; i < sampleCount; i += 1) {
          channel[i] = view.getInt16(i * 2, true) / 32768;
        }
        const source = speakerContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(speakerContext.destination);
        const startAt = Math.max(speakerPlaybackCursor, speakerContext.currentTime + 0.02);
        source.start(startAt);
        speakerPlaybackCursor = startAt + audioBuffer.duration;
      }

      async function pauseRecognitionForOutput() {
        if (!recording || isPausedForOutput) return;
        try {
          await recording.pause();
          isPausedForOutput = true;
          latestTranscript = "";
          lastNonEmptyTranscript = "";
          pendingTranscript = "";
          pendingFinalize = false;
          debug("Paused Soniox during Gemini output");
        } catch (error) {
          debug("Failed to pause Soniox", String(error?.message || error || "Unknown error"));
        }
      }

      async function resumeRecognitionAfterOutput() {
        if (!recording || !isPausedForOutput) return;
        try {
          await recording.resume();
          isPausedForOutput = false;
          latestTranscript = "";
          lastNonEmptyTranscript = "";
          pendingTranscript = "";
          pendingFinalize = false;
          debug("Resumed Soniox after Gemini output");
          setStatus("Listening", "Speak again whenever you want.", "live");
        } catch (error) {
          debug("Failed to resume Soniox", String(error?.message || error || "Unknown error"));
        }
      }

      async function processGeminiMessage(message) {
        const content = message?.serverContent;
        if (content?.outputTranscription?.text) {
          outputTranscript.textContent = content.outputTranscription.text;
        }
        if (content?.modelTurn?.parts) {
          isGeminiSpeaking = true;
          await pauseRecognitionForOutput();
          for (const part of content.modelTurn.parts) {
            if (part.inlineData?.data) {
              await playPcm24kBase64(part.inlineData.data);
            }
          }
        }
        if (content?.turnComplete) {
          debug("Gemini turn complete");
          isGeminiSpeaking = false;
          await resumeRecognitionAfterOutput();
        }
        if (message?.usageMetadata?.totalTokenCount) {
          debug("Usage update", message.usageMetadata.totalTokenCount + " total tokens");
        }
      }

      async function openGeminiSession() {
        const apiKey = getBrowserGeminiApiKey();
        ai = new GoogleGenAI({
          apiKey,
          httpOptions: { apiVersion: "v1alpha" },
        });

        session = await ai.live.connect({
          model: "gemini-3.1-flash-live-preview",
          config: {
            responseModalities: [Modality.AUDIO],
            outputAudioTranscription: {},
            thinkingConfig: {
              thinkingLevel: "minimal",
            },
            realtimeInputConfig: {
              automaticActivityDetection: {
                disabled: false,
                startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW,
                endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
                prefixPaddingMs: 20,
                silenceDurationMs: 120,
              },
            },
          },
          callbacks: {
            onopen: function () {
              debug("Gemini Live session opened");
              setStatus("Listening", "Soniox STT and Gemini audio output are connected.", "live");
            },
            onmessage: function (message) {
              processGeminiMessage(message).catch((error) => {
                debug("Gemini message processing failed", String(error?.message || error || "Unknown error"));
              });
            },
            onerror: function (e) {
              debug("Gemini Live error", e?.message || "Unknown error");
              setStatus("Error", e?.message || "Gemini Live error", "retry");
              debugLog.classList.add("error");
            },
            onclose: function (e) {
              debug("Gemini Live closed", e?.reason || "closed");
              if (isRunning) {
                setStatus("Closed", e?.reason || "Gemini session closed.", "off");
              }
            },
          },
        });
      }

      async function submitTranscript(text) {
        const transcript = String(text || "").trim();
        if (!transcript) return;
        if (!session) return;
        if (transcript === lastSubmittedTranscript) {
          debug("Skipping duplicate transcript", transcript);
          return;
        }
        lastSubmittedTranscript = transcript;
        liveTranscript.textContent = transcript;
        outputTranscript.textContent = "...";
        debug("Submitting transcript to Gemini", transcript);
        setStatus("Thinking", "Sending text turn to Gemini Live.", "llm");
        session.sendClientContent({
          turns: transcript,
          turnComplete: true,
        });
      }

      async function startSonioxRecording() {
        const sonioxClient = new SonioxClient({
          api_key: fetchSonioxTempKey,
        });

        recording = sonioxClient.realtime.record({
          model: "stt-rt-v4",
          language_hints: ["ar", "en"],
          enable_language_identification: true,
          enable_endpoint_detection: true,
          max_endpoint_delay_ms: 500,
          auto_reconnect: true,
          max_reconnect_attempts: 3,
          reconnect_base_delay_ms: 1000,
        });

        recording.on("connected", () => {
          debug("Soniox connected");
          setStatus("Listening", "Soniox STT and Gemini audio output are connected.", "live");
        });

        recording.on("result", (result) => {
          if (isPausedForOutput || isGeminiSpeaking) return;
          const tokens = Array.isArray(result?.tokens) ? result.tokens : [];
          latestTranscript = tokens.map((token) => String(token?.text || "")).join("").trim();
          if (latestTranscript) {
            lastNonEmptyTranscript = latestTranscript;
            liveTranscript.textContent = latestTranscript;
            voiceMeter.textContent = "hearing";
          }
        });

        recording.on("endpoint", async () => {
          if (!recording || isPausedForOutput || isGeminiSpeaking) return;
          pendingFinalize = true;
          pendingTranscript = latestTranscript || lastNonEmptyTranscript || "";
          debug("Soniox endpoint detected");
          setStatus("Endpoint", "Finalizing spoken turn.", "...");
          try {
            await recording.finalize();
          } catch (_) {}
        });

        recording.on("finalized", async () => {
          if (!pendingFinalize || isPausedForOutput || isGeminiSpeaking) return;
          pendingFinalize = false;
          const transcript = pendingTranscript || latestTranscript || lastNonEmptyTranscript || "";
          pendingTranscript = "";
          latestTranscript = "";
          lastNonEmptyTranscript = "";
          debug("Soniox transcript finalized", transcript || "(empty)");
          await submitTranscript(transcript);
        });

        recording.on("error", (error) => {
          debug("Soniox error", String(error?.message || error || "Unknown error"));
          setStatus("Error", String(error?.message || error || "Soniox error"), "retry");
          debugLog.classList.add("error");
        });

        recording.on("state_change", ({ new_state }) => {
          debug("Soniox state changed", new_state);
          if (new_state === "recording") {
            voiceMeter.textContent = "live";
          } else if (new_state === "paused") {
            voiceMeter.textContent = "paused";
          }
        });
      }

      async function startDemo() {
        if (isRunning) return;
        debugLog.classList.remove("error");
        liveTranscript.textContent = "...";
        outputTranscript.textContent = "...";
        latestTranscript = "";
        lastNonEmptyTranscript = "";
        pendingTranscript = "";
        lastSubmittedTranscript = "";
        pendingFinalize = false;
        isPausedForOutput = false;
        isGeminiSpeaking = false;
        isRunning = true;
        startBtn.disabled = true;
        stopBtn.disabled = false;
        setStatus("Starting", "Opening Gemini Live and Soniox STT.", "...");
        debug("Starting Soniox + Gemini demo");

        try {
          await setupSpeaker();
          await openGeminiSession();
          await startSonioxRecording();
          debug("Hybrid voice pipeline started");
        } catch (error) {
          debug("Start failed", String(error?.message || error || "Unknown error"));
          debugLog.classList.add("error");
          setStatus("Error", String(error?.message || error || "Failed to start"), "!");
          await stopDemo();
        }
      }

      async function stopDemo() {
        isRunning = false;
        isPausedForOutput = false;
        isGeminiSpeaking = false;
        pendingFinalize = false;

        if (recording) {
          try { await recording.stop(); } catch (_) {}
          recording = null;
        }

        if (session) {
          try { session.close(); } catch (_) {}
          session = null;
        }

        if (speakerContext) {
          try { await speakerContext.close(); } catch (_) {}
          speakerContext = null;
          speakerPlaybackCursor = 0;
        }

        ai = null;
        startBtn.disabled = false;
        stopBtn.disabled = true;
        setStatus("Stopped", "Soniox and Gemini session closed.", "off");
        debug("Stopped Soniox + Gemini demo");
      }

      startBtn.addEventListener("click", () => {
        startDemo().catch((error) => {
          debug("Unhandled start error", String(error?.message || error || "Unknown error"));
          debugLog.classList.add("error");
          setStatus("Error", String(error?.message || error || "Failed to start"), "!");
        });
      });

      stopBtn.addEventListener("click", () => {
        stopDemo().catch((error) => {
          debug("Stop failed", String(error?.message || error || "Unknown error"));
        });
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

  res.status(400).json({ error: "Invalid action" });
};
