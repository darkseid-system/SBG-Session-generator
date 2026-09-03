const express = require("express");
const pino = require("pino");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");

const app = express();
app.use(express.json({limit: "20kb"}));

const PORT = process.env.PORT || 3000;
const AUTH_ROOT = path.join(process.cwd(), "sessions");
fs.mkdirSync(AUTH_ROOT, {recursive: true});

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false
});
app.use("/api/pair", limiter);

const active = new Map();

function cleanPhone(value) {
  return String(value || "").replace(/\D/g, "");
}

async function createSocket(phone) {
  const dir = path.join(AUTH_ROOT, phone);
  fs.mkdirSync(dir, {recursive: true});

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    version = undefined;
  }

  const sock = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: false,
    logger: pino({level: "silent"}),
    browser: ["SBG-MD", "Chrome", "1.0.0"],
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({connection, lastDisconnect}) => {
    if (connection === "open") {
      console.log(`[SBG-MD] WhatsApp connected: ${phone}`);
      active.delete(phone);
    }
    if (connection === "close") {
      active.delete(phone);
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(() => createSocket(phone).catch(() => {}), 5000);
      }
    }
  });

  return sock;
}

app.get("/api/health", (_req, res) => {
  res.json({ok: true, service: "SBG-MD session backend"});
});

app.post("/api/pair", async (req, res) => {
  const phone = cleanPhone(req.body?.phone);

  if (!/^\d{8,15}$/.test(phone)) {
    return res.status(400).json({error: "Invalid international phone number."});
  }

  if (active.has(phone)) {
    return res.status(429).json({error: "A pairing request is already running for this number. Wait a moment."});
  }

  try {
    active.set(phone, Date.now());
    const sock = await createSocket(phone);

    // WhatsApp requires the socket to be connected before requesting the pairing code.
    await new Promise(resolve => setTimeout(resolve, 2500));

    if (sock.authState?.creds?.registered) {
      active.delete(phone);
      return res.status(409).json({error: "This number already has a saved SBG-MD session on this server."});
    }

    const code = await sock.requestPairingCode(phone);
    active.delete(phone);
    return res.json({code});
  } catch (err) {
    active.delete(phone);
    console.error("[SBG-MD] Pairing error:", err);
    return res.status(500).json({error: "Unable to generate the pairing code. Try again in a moment."});
  }
});

app.use(express.static(path.join(process.cwd(), "public")));
app.get("*", (_req, res) => res.sendFile(path.join(process.cwd(), "public", "index.html")));

app.listen(PORT, () => {
  console.log(`SBG-MD server listening on port ${PORT}`);
});
