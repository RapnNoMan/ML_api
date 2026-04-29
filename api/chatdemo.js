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

async function createGeminiEphemeralToken() {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    return { ok: false, status: 500, error: "Missing GEMINI_API_KEY or GOOGLE_API_KEY" };
  }

  const expireTime = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const newSessionExpireTime = new Date(Date.now() + 60 * 1000).toISOString();

  let response;
  try {
    response = await fetch("https://generativelanguage.googleapis.com/v1alpha/authTokens:create", {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        authToken: {
          uses: 1,
          expireTime,
          newSessionExpireTime,
        },
      }),
    });
  } catch (_) {
    return { ok: false, status: 502, error: "Gemini ephemeral token request failed" };
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch (_) {}

  if (!response.ok) {
    return {
      ok: false,
      status: response.status || 502,
      error: payload?.error?.message || payload?.message || "Gemini ephemeral token request failed",
      details: payload || null,
    };
  }

  return {
    ok: true,
    token: String(payload?.name || "").trim(),
    expireTime: payload?.expireTime || expireTime,
    newSessionExpireTime: payload?.newSessionExpireTime || newSessionExpireTime,
  };
}

function renderPage(agentId) {
  const safeAgentId = escapeHtml(agentId || "");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>Gemini Live Demo</title>
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
      }
      .debugbox {
        min-height: 140px;
        max-height: 32vh;
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
            <span id="statusDetail">Gemini Live audio in and audio out test.</span>
          </div>
          <div class="meter" id="voiceMeter">off</div>
        </div>
        <div class="controls">
          <button class="primary" id="startBtn">Start Listening</button>
          <button class="secondary" id="stopBtn" disabled>Stop</button>
        </div>
        <div class="livebox">
          <div class="label">Input Transcript</div>
          <div class="livetext" id="inputTranscript">...</div>
        </div>
        <div class="livebox">
          <div class="label">Output Transcript</div>
          <div class="livetext" id="outputTranscript">...</div>
        </div>
        <div class="livebox">
          <div class="label">Debug</div>
          <div class="debugbox" id="debugLog">Ready.&#10;Agent ID param (ignored): ${safeAgentId || "(none)"}</div>
        </div>
      </section>
    </main>
    <script type="module">
      import { GoogleGenAI, Modality, StartSensitivity, EndSensitivity } from "https://esm.sh/@google/genai?bundle";

      const endpoint = "/api/chatdemo";
      const statusTitle = document.getElementById("statusTitle");
      const statusDetail = document.getElementById("statusDetail");
      const voiceMeter = document.getElementById("voiceMeter");
      const inputTranscript = document.getElementById("inputTranscript");
      const outputTranscript = document.getElementById("outputTranscript");
      const debugLog = document.getElementById("debugLog");
      const startBtn = document.getElementById("startBtn");
      const stopBtn = document.getElementById("stopBtn");

      let ai = null;
      let session = null;
      let micStream = null;
      let micContext = null;
      let micSource = null;
      let micProcessor = null;
      let speakerContext = null;
      let speakerPlaybackCursor = 0;
      let isRunning = false;
      let suppressMic = false;
      let pendingStop = false;
      let chunkCount = 0;

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

      function base64FromBytes(bytes) {
        let binary = "";
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          const sub = bytes.subarray(i, i + chunkSize);
          binary += String.fromCharCode(...sub);
        }
        return btoa(binary);
      }

      function bytesFromBase64(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
          bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
      }

      function downsampleTo16k(input, inputSampleRate) {
        if (inputSampleRate === 16000) return input;
        const ratio = inputSampleRate / 16000;
        const newLength = Math.max(1, Math.round(input.length / ratio));
        const output = new Float32Array(newLength);
        let offsetResult = 0;
        let offsetBuffer = 0;
        while (offsetResult < output.length) {
          const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
          let accum = 0;
          let count = 0;
          for (let i = offsetBuffer; i < nextOffsetBuffer && i < input.length; i += 1) {
            accum += input[i];
            count += 1;
          }
          output[offsetResult] = count > 0 ? accum / count : 0;
          offsetResult += 1;
          offsetBuffer = nextOffsetBuffer;
        }
        return output;
      }

      function floatTo16BitPCM(float32) {
        const buffer = new ArrayBuffer(float32.length * 2);
        const view = new DataView(buffer);
        for (let i = 0; i < float32.length; i += 1) {
          let sample = Math.max(-1, Math.min(1, float32[i]));
          view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        }
        return new Uint8Array(buffer);
      }

      async function fetchGeminiToken() {
        debug("Requesting Gemini ephemeral token");
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "gemini_ephemeral_token" }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload?.token) {
          debug("Gemini token request failed", payload?.error || response.status);
          throw new Error(payload?.error || "Failed to obtain Gemini token");
        }
        debug("Gemini ephemeral token received");
        return payload.token;
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

      async function processServerMessage(message) {
        const content = message?.serverContent;
        if (content?.inputTranscription?.text) {
          inputTranscript.textContent = content.inputTranscription.text;
        }
        if (content?.outputTranscription?.text) {
          outputTranscript.textContent = content.outputTranscription.text;
        }
        if (content?.modelTurn?.parts) {
          suppressMic = true;
          for (const part of content.modelTurn.parts) {
            if (part.inlineData?.data) {
              await playPcm24kBase64(part.inlineData.data);
            }
          }
        }
        if (content?.turnComplete) {
          debug("Gemini turn complete");
          suppressMic = false;
          setStatus("Listening", "Gemini is ready for the next utterance.", "live");
        }
        if (message?.usageMetadata?.totalTokenCount) {
          debug("Usage update", message.usageMetadata.totalTokenCount + " total tokens");
        }
      }

      async function openGeminiSession() {
        const token = await fetchGeminiToken();
        ai = new GoogleGenAI({
          apiKey: token,
          httpOptions: { apiVersion: "v1alpha" },
        });

        session = await ai.live.connect({
          model: "gemini-3.1-flash-live-preview",
          config: {
            responseModalities: [Modality.AUDIO],
            inputAudioTranscription: {},
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
              setStatus("Listening", "Gemini Live is connected. Speak naturally.", "live");
            },
            onmessage: function (message) {
              processServerMessage(message).catch((error) => {
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
              if (!pendingStop) {
                setStatus("Closed", e?.reason || "Gemini session closed.", "off");
              }
            },
          },
        });
      }

      async function startMicrophonePipeline() {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });

        micContext = new AudioContext();
        if (micContext.state === "suspended") {
          await micContext.resume();
        }
        micSource = micContext.createMediaStreamSource(micStream);
        micProcessor = micContext.createScriptProcessor(4096, 1, 1);

        micProcessor.onaudioprocess = (event) => {
          if (!session || !isRunning || suppressMic) return;
          const input = event.inputBuffer.getChannelData(0);
          const downsampled = downsampleTo16k(input, micContext.sampleRate);
          const pcmBytes = floatTo16BitPCM(downsampled);
          const base64Audio = base64FromBytes(pcmBytes);
          chunkCount += 1;
          session.sendRealtimeInput({
            audio: {
              data: base64Audio,
              mimeType: "audio/pcm;rate=16000",
            },
          });
        };

        micSource.connect(micProcessor);
        micProcessor.connect(micContext.destination);
      }

      async function cleanupAudio() {
        if (micProcessor) {
          try { micProcessor.disconnect(); } catch (_) {}
          micProcessor.onaudioprocess = null;
          micProcessor = null;
        }
        if (micSource) {
          try { micSource.disconnect(); } catch (_) {}
          micSource = null;
        }
        if (micContext) {
          try { await micContext.close(); } catch (_) {}
          micContext = null;
        }
        if (micStream) {
          for (const track of micStream.getTracks()) {
            try { track.stop(); } catch (_) {}
          }
          micStream = null;
        }
      }

      async function startDemo() {
        if (isRunning) return;
        debugLog.classList.remove("error");
        inputTranscript.textContent = "...";
        outputTranscript.textContent = "...";
        chunkCount = 0;
        suppressMic = false;
        pendingStop = false;
        isRunning = true;
        startBtn.disabled = true;
        stopBtn.disabled = false;
        setStatus("Starting", "Opening Gemini Live session and microphone.", "...");
        debug("Starting Gemini Live demo");

        try {
          await setupSpeaker();
          await openGeminiSession();
          await startMicrophonePipeline();
          debug("Microphone pipeline started");
          setStatus("Listening", "Gemini Live is connected. Speak naturally.", "live");
        } catch (error) {
          debug("Start failed", String(error?.message || error || "Unknown error"));
          debugLog.classList.add("error");
          setStatus("Error", String(error?.message || error || "Failed to start"), "!");
          await stopDemo();
        }
      }

      async function stopDemo() {
        pendingStop = true;
        isRunning = false;
        suppressMic = false;

        if (session) {
          try {
            session.sendRealtimeInput({ audioStreamEnd: true });
          } catch (_) {}
          try {
            session.close();
          } catch (_) {}
          session = null;
        }

        await cleanupAudio();

        if (speakerContext) {
          try {
            await speakerContext.close();
          } catch (_) {}
          speakerContext = null;
          speakerPlaybackCursor = 0;
        }

        ai = null;
        startBtn.disabled = false;
        stopBtn.disabled = true;
        setStatus("Stopped", "Gemini Live session closed.", "off");
        debug("Stopped Gemini Live demo", chunkCount + " audio chunks sent");
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

  if (action === "gemini_ephemeral_token") {
    const result = await createGeminiEphemeralToken();
    res.status(result.status || (result.ok ? 200 : 500)).json(result);
    return;
  }

  res.status(400).json({ error: "Invalid action" });
};
