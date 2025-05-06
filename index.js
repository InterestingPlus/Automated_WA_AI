const BOT_START_TIME = Math.floor(Date.now() / 1000); // UNIX timestamp in seconds
const stopMap = new Map(); // JID => expiry timestamp (ms)

const DELAY_REPLY_MS = 4500; // 4.5 seconds delay
const pendingMessages = new Map(); // JID => [{ id, timestamp }]
const recentActivityMap = new Map(); // JID => timestamp of last manual reply

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const {
  default: WASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (_, res) => res.send("🤖 WhatsApp AI Bot is running."));
app.listen(PORT, () => console.log(`✅ Web server listening on port ${PORT}`));

const job = require("./cron");
const { buildPrompt } = require("./buildPropmt");
job.start();

const store = {};
const seenMessages = new Map(); // msgId => timestamp

function isMessageSeen(id) {
  const EXPIRY_MS = 1000 * 60 * 60 * 12; // 12 hours
  const now = Date.now();

  // Clean old messages
  for (const [mid, ts] of seenMessages) {
    if (now - ts > EXPIRY_MS) seenMessages.delete(mid);
  }

  if (seenMessages.has(id)) return true;

  seenMessages.set(id, now);
  return false;
}

const getMessage = (key) => {
  const { id } = key;
  return store[id]?.message;
};

function extractMessageText(message) {
  const msg = message.message;
  if (msg?.conversation) return msg.conversation;
  if (msg?.extendedTextMessage) return msg.extendedTextMessage.text;
  if (msg?.imageMessage?.caption) return msg.imageMessage.caption;
  if (msg?.videoMessage?.caption) return msg.videoMessage.caption;
  if (msg?.buttonsResponseMessage)
    return msg.buttonsResponseMessage.selectedButtonId;
  if (msg?.listResponseMessage) return msg.listResponseMessage.title;
  return false;
}

// 🤖 Gemini AI Handler
async function fetchGeminiReply(msg, senderName) {
  try {
    const prompt = buildPrompt(msg, senderName);

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }], role: "user" }],
      }
    );

    const reply =
      response.data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "Sorry, no reply.";

    return `🤖: ${reply}`;
  } catch (error) {
    console.error("Gemini API Error:", error.message);
    return "❌ Automated reply failed.";
  }
}

// 🔌 WhatsApp Socket Connection
async function connectWhatsAPP() {
  const { state, saveCreds } = await useMultiFileAuthState("auth");
  const { version } = await fetchLatestBaileysVersion();

  const socket = WASocket({
    printQRInTerminal: true,
    auth: state,
    version,
    browser: ["Chrome", "Desktop", "121.0.0.0"],
    getMessage,
    syncFullHistory: false,
  });

  socket.ev.on("creds.update", saveCreds);

  socket.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut;

      console.log("Connection closed. Reconnect?", shouldReconnect);

      if (shouldReconnect) {
        connectWhatsAPP();
      } else {
        console.log("❌ Disconnected. Logged out from WhatsApp.");
      }
    }

    if (connection === "open") {
      console.log("✅ Connected successfully to WhatsApp!");
    }
  });

  socket.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      const { key, messageTimestamp } = msg;
      const jid = key.remoteJid;
      const sender = msg.pushName || "Unknown";

      // ✅ 1. If message is from you (fromMe) — treat as manual reply
      if (key.fromMe) {
        recentActivityMap.set(jid, Date.now());
        console.log("🧍 Manual reply detected to:", jid);

        // Remove all pending messages for that JID
        if (pendingMessages.has(jid)) {
          console.log("✅ Skipping bot reply for", jid, "(manual reply sent)");
          pendingMessages.delete(jid);
        }
        continue;
      }

      // ✅ 2. Skip messages sent before bot started
      if (messageTimestamp < BOT_START_TIME) {
        console.log("⏩ Old message ignored:", extractMessageText(msg));
        continue;
      }

      // ✅ 3. Skip already seen messages
      if (isMessageSeen(key.id)) {
        console.log("👀 Already replied:", extractMessageText(msg));
        continue;
      }

      // ✅ 4. Extract text
      const text = extractMessageText(msg);
      if (!text) return;

      console.log(`📩 Message from ${sender}: "${text}"`);

      // ✅ 5. Handle #stop command
      if (text.toLowerCase().includes("#stop")) {
        stopMap.set(jid, Date.now() + 1000 * 60 * 60 * 5); // 5 hour
        await socket.sendMessage(
          jid,
          {
            text: "🤖 Auto-reply paused for 1 hour. Send any message to resume sooner.",
          },
          { quoted: msg }
        );
        console.log(`🛑 Auto-reply disabled for 5 hour for ${sender}`);
        continue;
      }

      // ✅ 6. Check if muted
      const muteUntil = stopMap.get(jid);
      if (muteUntil && Date.now() < muteUntil) {
        console.log(`🔕 Skipping (muted): ${sender}`);
        continue;
      }

      // ✅ 7. Delay reply logic (core update)
      pendingMessages.set(jid, [
        ...(pendingMessages.get(jid) || []),
        { id: key.id, msg, timestamp: Date.now() },
      ]);

      // Delay bot reply
      // Start typing while waiting
      await socket.sendPresenceUpdate("composing", jid);

      setTimeout(async () => {
        const pendings = pendingMessages.get(jid);
        if (!pendings) return;

        const current = pendings.find((m) => m.id === key.id);
        if (!current) return;

        const lastManual = recentActivityMap.get(jid);
        if (lastManual && lastManual > current.timestamp) {
          console.log(
            "🙈 Skipping bot reply (manual reply came in time):",
            text
          );
          pendingMessages.set(
            jid,
            pendings.filter((m) => m.id !== key.id)
          );

          // Stop typing since we won't reply
          await socket.sendPresenceUpdate("paused", jid);
          return;
        }

        const reply = await fetchGeminiReply(text, sender);
        await socket.sendMessage(jid, { text: reply }, { quoted: msg });
        recentActivityMap.set(jid, Date.now());
        console.log(`🤖 Replied to ${sender}: "${reply}"`);

        // Clean up and stop typing
        pendingMessages.set(
          jid,
          pendings.filter((m) => m.id !== key.id)
        );
        await socket.sendPresenceUpdate("paused", jid);
      }, DELAY_REPLY_MS);

      //
    }
  });
}

connectWhatsAPP();
