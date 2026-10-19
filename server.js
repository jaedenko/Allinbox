// Unified Gmail inbox: link many Gmail accounts, read them as one list.
// Runs locally. Tokens are stored in accounts.json next to this file.

const express = require("express");
const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = `http://localhost:${PORT}/oauth/callback`;
const STORE = path.join(__dirname, "accounts.json");

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET. See README.md.");
  process.exit(1);
}

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify", // read, archive, mark read
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.email",
];

// ---- token storage -------------------------------------------------------
const load = () => (fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, "utf8")) : {});
const save = (data) => fs.writeFileSync(STORE, JSON.stringify(data, null, 2), { mode: 0o600 });

function clientFor(email) {
  const accounts = load();
  if (!accounts[email]) throw new Error(`Unknown account ${email}`);
  const c = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  c.setCredentials(accounts[email]);
  // Persist refreshed tokens automatically
  c.on("tokens", (t) => {
    const all = load();
    all[email] = { ...all[email], ...t };
    save(all);
  });
  return c;
}

const newOAuthClient = () => new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

// ---- helpers -------------------------------------------------------------
const header = (msg, name) =>
  (msg.payload.headers.find((h) => h.name.toLowerCase() === name.toLowerCase()) || {}).value || "";

function decodeBody(payload) {
  const walk = (p, mime) => {
    if (p.mimeType === mime && p.body && p.body.data) {
      return Buffer.from(p.body.data, "base64url").toString("utf8");
    }
    for (const part of p.parts || []) {
      const r = walk(part, mime);
      if (r) return r;
    }
    return "";
  };
  return { html: walk(payload, "text/html"), text: walk(payload, "text/plain") };
}

async function listFor(email, { q, maxResults, label }) {
  const gmail = google.gmail({ version: "v1", auth: clientFor(email) });
  const list = await gmail.users.messages.list({
    userId: "me",
    maxResults,
    q: q || undefined,
    labelIds: [label || "INBOX"],
  });
  const ids = (list.data.messages || []).map((m) => m.id);
  const msgs = await Promise.all(
    ids.map((id) =>
      gmail.users.messages.get({
        userId: "me",
        id,
        format: "metadata",
        metadataHeaders: ["From", "Subject", "Date"],
      })
    )
  );
  return msgs.map(({ data: m }) => ({
    id: m.id,
    account: email,
    threadId: m.threadId,
    from: header(m, "From"),
    subject: header(m, "Subject") || "(no subject)",
    date: Number(m.internalDate),
    snippet: m.snippet,
    unread: (m.labelIds || []).includes("UNREAD"),
  }));
}

// ---- app -----------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Start linking an account
app.get("/oauth/start", (req, res) => {
  const url = newOAuthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent select_account", // always show account chooser + ensure refresh token
    scope: SCOPES,
  });
  res.redirect(url);
});

app.get("/oauth/callback", async (req, res) => {
  try {
    const c = newOAuthClient();
    const { tokens } = await c.getToken(req.query.code);
    c.setCredentials(tokens);
    const { data } = await google.oauth2({ version: "v2", auth: c }).userinfo.get();
    const all = load();
    // Keep an existing refresh token if Google didn't send a new one
    all[data.email] = { ...(all[data.email] || {}), ...tokens };
    save(all);
    res.redirect("/");
  } catch (e) {
    res.status(500).send("Linking failed: " + e.message);
  }
});

app.get("/api/accounts", (req, res) => res.json(Object.keys(load())));

app.delete("/api/accounts/:email", (req, res) => {
  const all = load();
  delete all[req.params.email];
  save(all);
  res.json({ ok: true });
});

// Merged inbox across every linked account
app.get("/api/inbox", async (req, res) => {
  const emails = Object.keys(load());
  const only = req.query.account;
  const targets = only ? emails.filter((e) => e === only) : emails;
  const perAccount = Math.min(Number(req.query.limit) || 25, 100);
  const results = await Promise.allSettled(
    targets.map((e) =>
      listFor(e, { q: req.query.q, maxResults: perAccount, label: req.query.label })
    )
  );
  const messages = [];
  const errors = [];
  results.forEach((r, i) =>
    r.status === "fulfilled"
      ? messages.push(...r.value)
      : errors.push({ account: targets[i], error: r.reason.message })
  );
  messages.sort((a, b) => b.date - a.date);
  res.json({ messages, errors });
});

// Read one message in full
app.get("/api/message/:account/:id", async (req, res) => {
  try {
    const gmail = google.gmail({ version: "v1", auth: clientFor(req.params.account) });
    const { data } = await gmail.users.messages.get({
      userId: "me",
      id: req.params.id,
      format: "full",
    });
    if ((data.labelIds || []).includes("UNREAD")) {
      await gmail.users.messages.modify({
        userId: "me",
        id: req.params.id,
        requestBody: { removeLabelIds: ["UNREAD"] },
      });
    }
    res.json({
      from: header(data, "From"),
      to: header(data, "To"),
      subject: header(data, "Subject"),
      date: header(data, "Date"),
      messageId: header(data, "Message-ID"),
      threadId: data.threadId,
      ...decodeBody(data.payload),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Archive a message (remove from inbox)
app.post("/api/message/:account/:id/archive", async (req, res) => {
  try {
    const gmail = google.gmail({ version: "v1", auth: clientFor(req.params.account) });
    await gmail.users.messages.modify({
      userId: "me",
      id: req.params.id,
      requestBody: { removeLabelIds: ["INBOX"] },
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Send / reply from a chosen account
app.post("/api/send", async (req, res) => {
  try {
    const { account, to, subject, body, threadId, inReplyTo } = req.body;
    const gmail = google.gmail({ version: "v1", auth: clientFor(account) });
    const lines = [
      `From: ${account}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
      inReplyTo ? `References: ${inReplyTo}` : null,
      "Content-Type: text/plain; charset=utf-8",
      "",
      body,
    ].filter((l) => l !== null);
    const raw = Buffer.from(lines.join("\r\n")).toString("base64url");
    await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw, threadId: threadId || undefined },
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`Unified inbox running at http://localhost:${PORT}`));
