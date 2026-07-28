import "dotenv/config";
import express from "express";
import nodemailer from "nodemailer";
import webpush from "web-push";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkDomain, daysUntil, DomainValidationError, normalizeDomain, reminderKey, remindersDue, renewalState } from "./lib/domain-service.js";
import { connectDatabase } from "./lib/database.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const domainsPath = path.join(root, "data", "domains.json");
const port = Number(process.env.PORT || 3000);
const thresholds = (process.env.REMINDER_DAYS || "60,30,14,7,3,1")
  .split(",").map(Number).filter(Number.isFinite).sort((a, b) => b - a);

const seedDomains = JSON.parse(await fs.readFile(domainsPath, "utf8"))
  .map(({ autoRenew: _unused, ...domain }) => domain);
const database = await connectDatabase({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
  seedDomains
});
const initialState = await database.loadState();
let domains = initialState.domains;
let runtime = {
  health: initialState.health,
  remindersSent: initialState.remindersSent,
  pushSent: initialState.pushSent,
  subscriptions: initialState.subscriptions
};

async function refreshState() {
  const state = await database.loadState();
  domains = state.domains;
  runtime = {
    health: state.health,
    remindersSent: state.remindersSent,
    pushSent: state.pushSent,
    subscriptions: state.subscriptions
  };
}

function publicDomain(domain) {
  return {
    ...domain,
    renewalState: renewalState(domain.expiresAt),
    daysUntilRenewal: daysUntil(domain.expiresAt),
    health: runtime.health[domain.name] || null
  };
}

async function probeOne(domain) {
  const previous = runtime.health[domain.name];
  const health = await checkDomain(domain.name);
  runtime.health[domain.name] = health;
  await database.saveHealth(domain.name, health);
  await notifyHealthChanges([{ domain, previous, health }]);
  return publicDomain(domain);
}

async function probeAll() {
  await refreshState();
  // Small batches avoid saturating DNS resolvers and the server's sockets.
  for (let index = 0; index < domains.length; index += 10) {
    const batch = domains.slice(index, index + 10);
    const results = await Promise.all(batch.map((domain) => checkDomain(domain.name)));
    const changes = batch.map((domain, resultIndex) => ({
      domain,
      previous: runtime.health[domain.name],
      health: results[resultIndex]
    }));
    changes.forEach(({ domain, health }) => { runtime.health[domain.name] = health; });
    await Promise.all(changes.map(({ domain, health }) => database.saveHealth(domain.name, health)));
    await notifyHealthChanges(changes);
  }
  return domains.map(publicDomain);
}

const pushConfigured = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (pushConfigured) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:admin@bilimtechnologies.in",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

async function sendPush(payload) {
  if (!pushConfigured || !runtime.subscriptions.length) return 0;
  const expired = new Set();
  let sent = 0;
  await Promise.all(runtime.subscriptions.map(async (subscription) => {
    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: 86_400 });
      sent += 1;
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) expired.add(subscription.endpoint);
      else console.warn(`Push delivery failed: ${error.message}`);
    }
  }));
  if (expired.size) {
    runtime.subscriptions = runtime.subscriptions.filter(({ endpoint }) => !expired.has(endpoint));
    await database.deleteSubscriptions([...expired]);
  }
  return sent;
}

async function notifyHealthChanges(changes) {
  const down = changes.filter(({ previous, health }) => previous?.status === "active" && health.status !== "active");
  if (!down.length) return;
  const names = down.map(({ domain }) => domain.name);
  await sendPush({
    title: `${names.length} domain${names.length === 1 ? " is" : "s are"} down`,
    body: names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`,
    tag: "domain-health",
    url: "/#portfolio"
  });
}

async function sendRenewalPush() {
  if (!runtime.subscriptions.length) return { sent: 0 };
  const due = remindersDue(domains, thresholds, runtime.pushSent);
  if (!due.length) return { sent: 0 };
  const deliveryCount = await sendPush({
    title: `${due.length} domain renewal${due.length === 1 ? "" : "s"} approaching`,
    body: due.slice(0, 3).map((domain) => `${domain.name} (${daysUntil(domain.expiresAt)}d)`).join(", "),
    tag: "domain-renewals",
    url: "/#portfolio"
  });
  if (deliveryCount) {
    const sentAt = new Date().toISOString();
    const deliveries = due.map((domain) => ({ key: reminderKey(domain, thresholds), sentAt }));
    deliveries.forEach(({ key }) => { runtime.pushSent[key] = sentAt; });
    await database.markDeliveries("push", deliveries);
  }
  return { sent: deliveryCount };
}

function smtpTransport() {
  if (!process.env.SMTP_HOST || !process.env.REMINDER_EMAIL) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
  });
}

function reminderMarkup(dueDomains, title = "Domain renewals need attention") {
  const rows = dueDomains.map((domain) => {
    const days = daysUntil(domain.expiresAt);
    return `<tr><td style="padding:12px;border-bottom:1px solid #e5e7eb"><strong>${domain.name}</strong></td><td style="padding:12px;border-bottom:1px solid #e5e7eb">${domain.expiresAt}</td><td style="padding:12px;border-bottom:1px solid #e5e7eb;color:#b45309">${days} day${days === 1 ? "" : "s"}</td><td style="padding:12px;border-bottom:1px solid #e5e7eb">₹${domain.price.toLocaleString("en-IN")}</td></tr>`;
  }).join("");
  return `<div style="font-family:Arial,sans-serif;max-width:680px;margin:auto;color:#17201c"><h1 style="font-size:24px">${title}</h1><p style="color:#64706a">This is an automatic reminder from Bilim Domain Watch.</p><table style="width:100%;border-collapse:collapse"><thead><tr style="text-align:left;background:#f3f5f2"><th style="padding:12px">Domain</th><th style="padding:12px">Renewal</th><th style="padding:12px">Time left</th><th style="padding:12px">Cost</th></tr></thead><tbody>${rows}</tbody></table><p style="margin-top:24px"><a href="${process.env.APP_URL || "https://domains.bilimtechnologies.in"}" style="background:#17201c;color:#fff;padding:11px 16px;text-decoration:none">Open dashboard</a></p></div>`;
}

async function sendReminders({ test = false } = {}) {
  const transport = smtpTransport();
  if (!transport) throw new Error("SMTP_HOST and REMINDER_EMAIL must be configured");
  const due = test ? domains.slice(0, 2) : remindersDue(domains, thresholds, runtime.remindersSent);
  if (!due.length) return { sent: 0 };
  await transport.sendMail({
    from: process.env.SMTP_FROM || "Bilim Domain Watch <domains@bilimtechnologies.in>",
    to: process.env.REMINDER_EMAIL,
    subject: test ? "Test: Bilim domain renewal reminder" : `${due.length} domain renewal${due.length === 1 ? "" : "s"} approaching`,
    html: reminderMarkup(due, test ? "Your reminders are working" : undefined)
  });
  if (!test) {
    const sentAt = new Date().toISOString();
    const deliveries = due.map((domain) => ({ key: reminderKey(domain, thresholds), sentAt }));
    deliveries.forEach(({ key }) => { runtime.remindersSent[key] = sentAt; });
    await database.markDeliveries("email", deliveries);
  }
  return { sent: due.length };
}

const app = express();
app.disable("x-powered-by");

app.use((request, response, next) => {
  const cronAuthorized = request.path.startsWith("/api/cron/")
    && process.env.CRON_SECRET
    && request.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  if (cronAuthorized) return next();
  if (!process.env.ADMIN_USER || !process.env.ADMIN_PASSWORD) return next();
  const [scheme, encoded] = (request.headers.authorization || "").split(" ");
  const supplied = scheme === "Basic" && encoded ? Buffer.from(encoded, "base64").toString().split(":") : [];
  if (supplied[0] === process.env.ADMIN_USER && supplied.slice(1).join(":") === process.env.ADMIN_PASSWORD) return next();
  response.set("WWW-Authenticate", 'Basic realm="Bilim Domain Watch"');
  return response.status(401).send("Authentication required");
});

app.use(express.json());
app.use(express.static(path.join(root, "public"), { maxAge: process.env.NODE_ENV === "production" ? "1h" : 0 }));

app.get("/api/health", async (_request, response, next) => {
  try {
    await refreshState();
    response.json({ ok: true, database: "turso", domains: domains.length });
  } catch (error) { next(error); }
});
app.get("/api/push/config", (_request, response) => response.json({
  configured: pushConfigured,
  publicKey: pushConfigured ? process.env.VAPID_PUBLIC_KEY : null
}));
app.post("/api/push/subscribe", async (request, response, next) => {
  const subscription = request.body;
  if (!pushConfigured) return response.status(503).json({ error: "Push notifications are not configured" });
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return response.status(400).json({ error: "Invalid push subscription" });
  }
  try {
    runtime.subscriptions = runtime.subscriptions.filter(({ endpoint }) => endpoint !== subscription.endpoint);
    runtime.subscriptions.push(subscription);
    await database.saveSubscription(subscription);
    return response.status(201).json({ subscribed: true });
  } catch (error) { return next(error); }
});
app.post("/api/push/unsubscribe", async (request, response, next) => {
  try {
    const endpoint = request.body?.endpoint;
    runtime.subscriptions = runtime.subscriptions.filter((subscription) => subscription.endpoint !== endpoint);
    await database.deleteSubscriptions(endpoint ? [endpoint] : []);
    return response.json({ subscribed: false });
  } catch (error) { return next(error); }
});
app.get("/api/domains", async (_request, response, next) => {
  try {
    await refreshState();
    response.json(domains.map(publicDomain));
  } catch (error) { next(error); }
});
app.post("/api/domains", async (request, response, next) => {
  try {
    await refreshState();
    const domain = normalizeDomain(request.body);
    if (domains.some((item) => item.name === domain.name)) {
      return response.status(409).json({ error: `${domain.name} is already being tracked` });
    }
    await database.addDomain(domain);
    domains.push(domain);
    domains.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
    return response.status(201).json(publicDomain(domain));
  } catch (error) {
    if (error instanceof DomainValidationError) return response.status(400).json({ error: error.message });
    return next(error);
  }
});
app.post("/api/domains/check-all", async (_request, response, next) => {
  try { response.json(await probeAll()); } catch (error) { next(error); }
});
app.post("/api/domains/:name/check", async (request, response, next) => {
  await refreshState();
  const domain = domains.find((item) => item.name === request.params.name.toLowerCase());
  if (!domain) return response.status(404).json({ error: "Domain not found" });
  try { return response.json(await probeOne(domain)); } catch (error) { return next(error); }
});
app.post("/api/reminders/test", async (_request, response, next) => {
  try { response.json(await sendReminders({ test: true })); } catch (error) { next(error); }
});
app.get("/api/cron/check-domains", async (request, response, next) => {
  if (!process.env.CRON_SECRET || request.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return response.status(401).json({ error: "Unauthorized" });
  }
  try {
    const checked = await probeAll();
    return response.json({ ok: true, checked: checked.length, completedAt: new Date().toISOString() });
  } catch (error) { return next(error); }
});
app.get("/api/cron/send-reminders", async (request, response, next) => {
  if (!process.env.CRON_SECRET || request.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return response.status(401).json({ error: "Unauthorized" });
  }
  try {
    await refreshState();
    let email = { sent: 0 };
    let emailError = null;
    try { email = await sendReminders(); } catch (error) { emailError = error.message; }
    const push = await sendRenewalPush();
    return response.json({ ok: true, email, push, emailError, completedAt: new Date().toISOString() });
  } catch (error) { return next(error); }
});

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ error: error.message || "Unexpected server error" });
});

if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`Bilim Domain Watch listening on http://localhost:${port}`);
    setTimeout(() => probeAll().catch(console.error), 1_000);
    setTimeout(() => sendReminders().catch((error) => console.warn(`Reminder check skipped: ${error.message}`)), 2_000);
    setTimeout(() => sendRenewalPush().catch(console.error), 2_500);
  });
  const checkInterval = Number(process.env.CHECK_INTERVAL_HOURS || 24) * 3_600_000;
  setInterval(() => probeAll().catch(console.error), checkInterval).unref();
  setInterval(() => sendReminders().catch((error) => console.warn(`Reminder check skipped: ${error.message}`)), 3_600_000).unref();
  setInterval(() => sendRenewalPush().catch(console.error), 3_600_000).unref();
}

export default app;
