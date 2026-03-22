import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 5000;

// ─── Startup Check ────────────────────────────────────────────────────────────
if (!process.env.DEEPSEEK_API_KEY) {
  console.error("❌ DEEPSEEK_API_KEY is not set. Please add it to your environment variables.");
  process.exit(1); // Stop the server immediately if key is missing
}

// ─── CORS Configuration ───────────────────────────────────────────────────────
// Replace with your actual frontend URL(s) after deploying
const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:5173",
  process.env.FRONTEND_URL, // Set this in Render environment variables
].filter(Boolean); // Remove undefined entries

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g., mobile apps, Postman, curl)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`CORS policy: Origin "${origin}" is not allowed.`));
    },
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);

app.use(express.json());

// ─── Simple In-Memory Rate Limiter ────────────────────────────────────────────
// Allows max 20 requests per IP per minute
const rateLimitMap = new Map();
const RATE_LIMIT = 20;         // max requests
const RATE_WINDOW_MS = 60_000; // 1 minute window

function rateLimit(req, res, next) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const record = rateLimitMap.get(ip);

  if (!record || now - record.startTime > RATE_WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, startTime: now });
    return next();
  }

  if (record.count >= RATE_LIMIT) {
    return res.status(429).json({ error: "Too many requests. Please wait a moment and try again." });
  }

  record.count++;
  return next();
}

// ─── Per-Session Chat History ─────────────────────────────────────────────────
// Each session gets its own history (stored by sessionId sent from frontend)
const sessionHistories = new Map();
const MAX_HISTORY = 10;         // Keep last 10 messages per session
const SESSION_TTL_MS = 30 * 60_000; // Sessions expire after 30 minutes of inactivity

function getSessionHistory(sessionId) {
  const session = sessionHistories.get(sessionId);
  if (!session) return [];
  // Check if session has expired
  if (Date.now() - session.lastActive > SESSION_TTL_MS) {
    sessionHistories.delete(sessionId);
    return [];
  }
  return session.messages;
}

function saveSessionHistory(sessionId, messages) {
  sessionHistories.set(sessionId, {
    messages,
    lastActive: Date.now(),
  });
}

// Clean up expired sessions every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessionHistories.entries()) {
    if (now - session.lastActive > SESSION_TTL_MS) {
      sessionHistories.delete(id);
    }
  }
}, 10 * 60_000);

// ─── Health Check (Required by Render) ───────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "AI Assistant backend is running." });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// ─── Chat Endpoint ────────────────────────────────────────────────────────────
app.post("/chat", rateLimit, async (req, res) => {
  const { message, sessionId } = req.body;

  // Validate message
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "A valid message string is required." });
  }
  if (message.trim().length === 0) {
    return res.status(400).json({ error: "Message cannot be empty." });
  }
  if (message.length > 2000) {
    return res.status(400).json({ error: "Message is too long. Please keep it under 2000 characters." });
  }

  // Validate sessionId
  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ error: "A sessionId is required to maintain conversation history." });
  }

  try {
    // Get this user's history
    const history = getSessionHistory(sessionId);

    // Add the new user message
    history.push({ role: "user", content: message.trim() });

    // Trim history to the last MAX_HISTORY messages
    const trimmedHistory = history.slice(-MAX_HISTORY);

    // Call DeepSeek API
    const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          {
            role: "system",
            content:
              "You are a smart, helpful, and friendly AI assistant. Answer questions clearly and concisely.",
          },
          ...trimmedHistory,
        ],
        max_tokens: 1024,
        temperature: 0.7,
      }),
    });

    // Handle non-OK HTTP responses from DeepSeek
    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`DeepSeek API error [${response.status}]:`, errorBody);

      if (response.status === 401) {
        return res.status(502).json({ error: "Invalid DeepSeek API key. Please check your configuration." });
      }
      if (response.status === 429) {
        return res.status(429).json({ error: "The AI service is currently busy. Please try again shortly." });
      }
      return res.status(502).json({ error: "The AI service returned an unexpected error. Please try again." });
    }

    const data = await response.json();

    // Validate DeepSeek response shape
    const aiReply = data?.choices?.[0]?.message?.content;
    if (!aiReply) {
      console.error("Unexpected DeepSeek response shape:", JSON.stringify(data));
      return res.status(502).json({ error: "Received an unexpected response from the AI service." });
    }

    // Save updated history (with AI reply included)
    trimmedHistory.push({ role: "assistant", content: aiReply });
    saveSessionHistory(sessionId, trimmedHistory);

    return res.json({ reply: aiReply });
  } catch (error) {
    console.error("Unhandled server error:", error);
    return res.status(500).json({ error: "An internal server error occurred. Please try again." });
  }
});

// ─── 404 Handler ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: "Route not found." });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
