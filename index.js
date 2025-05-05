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

// Utils
function isActiveHours() {
  const hour = new Date().getHours();
  return hour >= 7 && hour < 23;
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
      if (!msg.message || msg.key.fromMe || !isActiveHours()) return;
      console.log(":::", msg);

      try {
        const msgId = msg.key.id;
        if (isMessageSeen(msgId)) return;

        seenMessages.set(msgId, Date.now()); // ✅ Save seen

        const text = extractMessageText(msg);
        if (!text) return;

        console.log(`📨 ${msg.pushName} = "${text}"`);

        if (msg.pushName !== "Full Stack Web Developer💜") {
          const reply = await fetchGeminiReply(text, msg.pushName);
          console.log(reply);

          await socket.sendMessage(msg.key.remoteJid, { text: reply });
        }
      } catch (err) {
        console.warn(
          "⚠️ Skipping undeliverable or undecryptable message:",
          err.message
        );
      }

      // Clean up memory
      if (seenMessages.size > 5000) {
        seenMessages.delete(seenMessages.keys().next().value);
      }
    }
  });
}

connectWhatsAPP();
