// server.js – Railway + PIX + Produtos/Pedidos + Telegram + (opcional) Web Push + Backup/Restore
const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const { QrCodePix } = require("qrcode-pix");

// web-push é opcional; só é usado se VAPID_* estiverem definidos
let webpush = null;
try { webpush = require("web-push"); } catch { /* opcional */ }

const app = express();
const PORT = process.env.PORT || 3000;

/* ------------------------------- Basic Auth / Token ------------------------- */
const ADMIN_USER  = process.env.ADMIN_USER  || "admin";
const ADMIN_PASS  = process.env.ADMIN_PASS  || "senha123";
const ADMIN_REALM = "Admin Panel";

// 🔑 token alternativo para rotas admin (além do Basic Auth)
const DEBUG_TOKEN = process.env.DEBUG_TOKEN || "segredo123";

function basicAuth(req, res, next) {
  const h = req.headers.authorization || "";
  const [type, b64] = h.split(" ");
  if (type === "Basic" && b64) {
    const [user, pass] = Buffer.from(b64, "base64").toString().split(":");
    if (user === ADMIN_USER && pass === ADMIN_PASS) return next();
  }
  res.set("WWW-Authenticate", `Basic realm="${ADMIN_REALM}", charset="UTF-8"`);
  return res.status(401).send("Autenticação requerida");
}

function tokenOrBasic(req, res, next) {
  const t = req.headers["x-admin-token"];
  if (t && String(t) === String(DEBUG_TOKEN)) return next();
  return basicAuth(req, res, next);
}

/* -------------------------------- Middlewares -------------------------------- */
app.use(express.json({ limit: "5mb" }));
app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
    allowedHeaders: ["Content-Type", "X-Admin-Token", "Authorization"],
  })
);

/* ------------------------------ Arquivos estáticos --------------------------- */
app.use(
  express.static(path.join(__dirname, "public"), {
    index: false,
  })
);

/* -------------------------- Rotas de páginas (UI) ---------------------------- */
app.get(["/", "/index", "/index.html"], basicAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get(["/delivery", "/delivery.html"], (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "delivery.html"));
});

app.get("/health", (_req, res) => res.json({ ok: true }));

/* ------------------------------- Banco em arquivo ---------------------------- */
const DATA_DIR = process.env.DATA_DIR || "/data";
const DB_FILE  = process.env.DB_FILE  || path.join(DATA_DIR, "db.json");

const dbDir = path.dirname(DB_FILE);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

function ensureDBShape(db) {
  db = db && typeof db === "object" ? db : {};
  db.produtos = Array.isArray(db.produtos) ? db.produtos : [];
  db.pedidos  = Array.isArray(db.pedidos)  ? db.pedidos  : [];
  db.pushSubs = Array.isArray(db.pushSubs) ? db.pushSubs : [];
  return db;
}
function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      const blank = ensureDBShape({});
      fs.writeFileSync(DB_FILE, JSON.stringify(blank, null, 2));
      return blank;
    }
    const raw = fs.readFileSync(DB_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return ensureDBShape(parsed);
  } catch (err) {
    console.warn("[db] erro ao ler/parsear, recriando:", err?.message);
    const blank = ensureDBShape({});
    fs.writeFileSync(DB_FILE, JSON.stringify(blank, null, 2));
    return blank;
  }
}
function saveDB(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(ensureDBShape(db), null, 2));
  } catch (err) {
    console.error("[db] erro ao salvar:", err?.message);
  }
}

/* -------------------------------- Config PIX -------------------------------- */
// Normaliza a chave PIX (telefone, CPF, etc.)
function normalizePixKey(raw) {
  if (!raw) return "";
  const s = String(raw).trim();
  if (s.includes("@") || s.includes("-") || s.length > 20) return s;
  const digits = s.replace(/\D+/g, "");
  if (digits.length === 11) return "55" + digits;
  if (digits.startsWith("55") && (digits.length === 13 || digits.length === 14)) return digits;
  return digits;
}

// Formata para exibir bonito no front
function formatPhoneIfAny(pixKey) {
  const d = String(pixKey || "");
  if (d.startsWith("55") && (d.length === 13 || d.length === 14)) {
    const base = d.slice(2);
    const ddd = base.slice(0, 2);
    const num = base.slice(2);
    return `(${ddd}) ${num.slice(0,5)}-${num.slice(5)}`;
  }
  return null;
}

// Chave PIX configurada
const PIX_KEY_RAW = "99 98833 8981";
const chavePix = normalizePixKey(PIX_KEY_RAW);
const nomeLoja = "SALGADOS RAYLENIZA";
const cidade   = "SAMBAIBA";

/* ----------------------------- Push Web (opcional) --------------------------- */
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT     || "mailto:suporte@exemplo.com";

if (webpush && VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
} else if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
  console.warn("[web-push] sem VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY — push web desativado.");
}

/* --------------------------- Telegram (notificação confiável) ------------------- */
const _fetch = (...args) =>
  (globalThis.fetch
    ? globalThis.fetch(...args)
    : import("node-fetch").then((m) => m.default(...args)));

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID    || "";

async function sendTelegramMessage(text) {
  try {
    if (!TG_TOKEN || !TG_CHAT) return;
    const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
    await _fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: "HTML" }),
    });
  } catch (e) {
    console.warn("[telegram] falhou:", e?.message);
  }
}

/* -------------------------------- API PIX ----------------------------------- */
app.get("/api/chave-pix", (_req, res) => {
  res.json({
    chave: chavePix,
    nome: nomeLoja,
    cidade,
    telefone: formatPhoneIfAny(chavePix)
  });
});

app.get("/api/pix/:valor/:txid?", async (req, res) => {
  try {
    const raw = String(req.params.valor).replace(",", ".");
    const valor = Number(raw);
    if (!Number.isFinite(valor) || valor < 0.01) {
      return res.status(400).json({ error: "Valor inválido (mínimo 0,01)" });
    }
    const txid = (req.params.txid || "PIX" + Date.now()).slice(0, 25);
    const qrCodePix = QrCodePix({
      version: "01",
      key: chavePix,
      name: nomeLoja,
      city: cidade,
      transactionId: txid,
      value: Number(valor.toFixed(2)),
    });
    const payload = qrCodePix.payload().replace(/\s+/g, "");
    const qrCodeImage = await qrCodePix.base64();
    res.set("Cache-Control", "no-store");
    res.json({ payload, qrCodeImage, txid, chave: chavePix });
  } catch (err) {
    console.error("Erro ao gerar PIX:", err);
    res.status(500).json({ error: "Falha ao gerar QR Code PIX" });
  }
});

/* ------------------------------- Produtos ----------------------------------- */
app.get("/api/produtos", (_req, res) => {
  const db = loadDB();
  res.json(db.produtos);
});

app.post("/api/produtos", tokenOrBasic, (req, res) => {
  const db = loadDB();
  const novo = { ...req.body, id: Date.now() };
  db.produtos.push(novo);
  saveDB(db);
  res.json(novo);
});
app.delete("/api/produtos/:id", tokenOrBasic, (req, res) => {
  const db = loadDB();
  const id = Number(req.params.id);
  db.produtos = db.produtos.filter((p) => p.id !== id);
  saveDB(db);
  res.json({ success: true });
});

/* -------------------------------- Pedidos ----------------------------------- */
app.post("/api/pedidos", async (req, res) => {
  const db = loadDB();
  const pedido = { ...req.body, id: Date.now(), status: "Pendente" };

  try {
    const rawTotal = String(pedido.total).replace(",", ".");
    const valor = Number(rawTotal);
    const txid = ("PED" + pedido.id).slice(0, 25);
    const qrCodePix = QrCodePix({
      version: "01",
      key: chavePix,
      name: nomeLoja,
      city: cidade,
      transactionId: txid,
      value: Number(valor.toFixed(2)),
    });
    pedido.pix = {
      payload: qrCodePix.payload().replace(/\s+/g, ""),
      qrCodeImage: await qrCodePix.base64(),
      txid,
      chave: chavePix,
    };
  } catch (err) {
    console.error("Erro ao gerar PIX do pedido:", err);
    pedido.pix = null;
  }

  db.pedidos.push(pedido);
  saveDB(db);
  res.json(pedido);
});

/* --------------------------------- Start ------------------------------------ */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
