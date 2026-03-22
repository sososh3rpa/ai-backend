import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 5000;

// ─── Startup API Key Check ────────────────────────────────────────────────────
if (!process.env.GROQ_API_KEY) {
  console.error("❌ GROQ_API_KEY is not set. Add it to your environment variables on Render.");
  process.exit(1);
}

// ─── CORS Configuration ───────────────────────────────────────────────────────
// Open to all origins — safe for a public portfolio, works on every device
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);

app.use(express.json());

// ─── Rate Limiter (No extra package needed) ───────────────────────────────────
// Max 30 requests per IP per minute
const rateLimitMap = new Map();
const MAX_REQUESTS = 30;
const WINDOW_MS = 60_000; // 1 minute

function rateLimit(req, res, next) {
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "unknown";

  const now = Date.now();
  const record = rateLimitMap.get(ip);

  if (!record || now - record.startTime > WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, startTime: now });
    return next();
  }

  if (record.count >= MAX_REQUESTS) {
    return res.status(429).json({
      error: "Too many requests. Please wait a minute and try again.",
    });
  }

  record.count++;
  return next();
}

// Clean up old rate limit records every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimitMap.entries()) {
    if (now - record.startTime > WINDOW_MS) rateLimitMap.delete(ip);
  }
}, 5 * 60_000);

// ─── Per-Session Chat History ─────────────────────────────────────────────────
// Each user gets their own conversation history using a sessionId
const sessionStore = new Map();
const MAX_HISTORY   = 10;          // Keep last 10 messages per session
const SESSION_TTL   = 30 * 60_000; // Sessions expire after 30 min of inactivity

function getHistory(sessionId) {
  const session = sessionStore.get(sessionId);
  if (!session) return [];
  if (Date.now() - session.lastActive > SESSION_TTL) {
    sessionStore.delete(sessionId);
    return [];
  }
  return session.messages;
}

function saveHistory(sessionId, messages) {
  sessionStore.set(sessionId, {
    messages,
    lastActive: Date.now(),
  });
}

// Clean up expired sessions every 15 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessionStore.entries()) {
    if (now - session.lastActive > SESSION_TTL) sessionStore.delete(id);
  }
}, 15 * 60_000);

// ─── Health Check Routes (Required by Render) ─────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "AI Assistant backend is live and running!",
    uptime: `${Math.floor(process.uptime())}s`,
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// ─── Main Chat Endpoint ────────────────────────────────────────────────────────
app.post("/chat", rateLimit, async (req, res) => {
  const { message, sessionId } = req.body;

  // ── Input Validation ────────────────────────────────────────────────────────
  if (!message || typeof message !== "string" || message.trim().length === 0) {
    return res.status(400).json({ error: "A valid non-empty message is required." });
  }
  if (message.length > 2000) {
    return res.status(400).json({
      error: "Message is too long. Please keep it under 2000 characters.",
    });
  }
  if (!sessionId || typeof sessionId !== "string" || sessionId.trim().length === 0) {
    return res.status(400).json({
      error: "A sessionId is required. Generate one in your frontend using crypto.randomUUID().",
    });
  }

  try {
    // ── Build Message History ─────────────────────────────────────────────────
    const history = getHistory(sessionId);
    history.push({ role: "user", content: message.trim() });

    // Keep only the last MAX_HISTORY messages to stay within token limits
    const trimmedHistory = history.slice(-MAX_HISTORY);

    // ── Call Groq API ─────────────────────────────────────────────────────────
    const groqResponse = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: "llama3-70b-8192", // Free, fast, and reliable
          messages: [
            {
              role: "system",
              content:
                "You are a smart, helpful, and friendly AI assistant. Answer questions clearly, concisely, and accurately.",
            },
            ...trimmedHistory,
          ],
          max_tokens: 1024,
          temperature: 0.7,
        }),
      }
    );

    // ── Handle Groq API Errors ────────────────────────────────────────────────
    if (!groqResponse.ok) {
      const errorText = await groqResponse.text();
      console.error(`Groq API Error [${groqResponse.status}]:`, errorText);

      if (groqResponse.status === 401) {
        return res.status(502).json({
          error: "Invalid Groq API key. Please check your environment variables on Render.",
        });
      }
      if (groqResponse.status === 429) {
        return res.status(429).json({
          error: "The AI service is busy right now. Please try again in a few seconds.",
        });
      }
      if (groqResponse.status === 503) {
        return res.status(503).json({
          error: "The AI service is temporarily unavailable. Please try again shortly.",
        });
      }
      return res.status(502).json({
        error: "The AI service returned an unexpected error. Please try again.",
      });
    }

    // ── Parse & Validate Response ─────────────────────────────────────────────
    const data = await groqResponse.json();
    const aiReply = data?.choices?.[0]?.message?.content;

    if (!aiReply) {
      console.error("Unexpected Groq response shape:", JSON.stringify(data));
      return res.status(502).json({
        error: "Received an unexpected response from the AI. Please try again.",
      });
    }

    // ── Save Updated History & Respond ────────────────────────────────────────
    trimmedHistory.push({ role: "assistant", content: aiReply });
    saveHistory(sessionId, trimmedHistory);

    return res.json({ reply: aiReply });

  } catch (error) {
    console.error("Unhandled server error:", error.message);
    return res.status(500).json({
      error: "An internal server error occurred. Please try again.",
    });
  }
});

// ─── 404 Handler ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route "${req.path}" not found.` });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}/`);
});
