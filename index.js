require("dotenv").config();
const {
  default: WASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");

const axios = require("axios");

const store = {};

// server.js or index.js
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (_, res) => {
  res.send("🤖 WhatsApp AI Bot is running.");
});

app.listen(PORT, () => console.log(`✅ Web server listening on port ${PORT}`));

const getMessage = (key) => {
  const { id } = key;
  return store[id]?.message;
};

const job = require("./cron");
job.start();


// 🤖 Gemini AI Handler
const { buildPrompt } = require("./buildPropmt");

const fetchGeminiReply = async (msg, senderName) => {
  console.log("user : ", msg);
  try {
    const prompt = buildPrompt(msg, senderName);

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [
          {
            parts: [
              {
                text: prompt,
              },
            ],
            role: "user",
          },
        ],
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
};

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

    if (
      connection === "close" &&
      lastDisconnect?.error?.output?.payload?.type === "replaced"
    ) {
      console.log("Session replaced. Possibly another instance is running.");
      // Optionally alert dev team or disable reconnection temporarily
    }

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
      if (!msg.message || msg.key.fromMe) return;

      const text = extractMessageText(msg);
      console.log(`📨 New message: ${msg.pushName} = ${text}`);

      if (!text) return;

      if (msg.pushName !== "Full Stack Web Developer💜") {
        const reply = await fetchGeminiReply(text, msg.pushName);

        console.log(reply);

        await socket.sendMessage(msg.key.remoteJid, { text: reply });
      }
    }
  });
}

connectWhatsAPP();

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
