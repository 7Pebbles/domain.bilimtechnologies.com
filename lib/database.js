import { createClient } from "@libsql/client";

function domainFromRow(row) {
  return {
    name: row.name,
    expiresAt: row.expires_at,
    price: Number(row.price),
    registeredAt: row.registered_at
  };
}

function healthFromRow(row) {
  return {
    status: row.status,
    dnsActive: Boolean(row.dns_active),
    httpActive: Boolean(row.http_active),
    statusCode: row.status_code === null ? null : Number(row.status_code),
    responseMs: row.response_ms === null ? null : Number(row.response_ms),
    addresses: JSON.parse(row.addresses || "[]"),
    checkedAt: row.checked_at
  };
}

export async function connectDatabase({ url, authToken, seedDomains = [] }) {
  if (!url || !authToken) throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be configured");
  const client = createClient({ url, authToken });

  await client.batch([
    `CREATE TABLE IF NOT EXISTS domains (
      name TEXT PRIMARY KEY,
      expires_at TEXT NOT NULL,
      price REAL NOT NULL CHECK (price > 0),
      registered_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS domain_health (
      domain_name TEXT PRIMARY KEY REFERENCES domains(name) ON DELETE CASCADE,
      status TEXT NOT NULL,
      dns_active INTEGER NOT NULL,
      http_active INTEGER NOT NULL,
      status_code INTEGER,
      response_ms INTEGER,
      addresses TEXT NOT NULL DEFAULT '[]',
      checked_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS reminder_deliveries (
      channel TEXT NOT NULL,
      reminder_key TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      PRIMARY KEY (channel, reminder_key)
    )`,
    `CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      subscription TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`
  ], "write");

  const count = await client.execute("SELECT COUNT(*) AS count FROM domains");
  if (Number(count.rows[0].count) === 0 && seedDomains.length) {
    await client.batch(seedDomains.map((domain) => ({
      sql: "INSERT INTO domains (name, expires_at, price, registered_at) VALUES (?, ?, ?, ?)",
      args: [domain.name, domain.expiresAt, domain.price, domain.registeredAt]
    })), "write");
  }

  return {
    async loadState() {
      const [domainResult, healthResult, deliveryResult, subscriptionResult] = await client.batch([
        "SELECT name, expires_at, price, registered_at FROM domains ORDER BY expires_at, name",
        "SELECT * FROM domain_health",
        "SELECT channel, reminder_key, sent_at FROM reminder_deliveries",
        "SELECT subscription FROM push_subscriptions ORDER BY created_at"
      ], "read");
      const health = {};
      healthResult.rows.forEach((row) => { health[row.domain_name] = healthFromRow(row); });
      const remindersSent = {};
      const pushSent = {};
      deliveryResult.rows.forEach((row) => {
        (row.channel === "email" ? remindersSent : pushSent)[row.reminder_key] = row.sent_at;
      });
      return {
        domains: domainResult.rows.map(domainFromRow),
        health,
        remindersSent,
        pushSent,
        subscriptions: subscriptionResult.rows.map((row) => JSON.parse(row.subscription))
      };
    },

    async addDomain(domain) {
      await client.execute({
        sql: "INSERT INTO domains (name, expires_at, price, registered_at) VALUES (?, ?, ?, ?)",
        args: [domain.name, domain.expiresAt, domain.price, domain.registeredAt]
      });
    },

    async saveHealth(domainName, health) {
      await client.execute({
        sql: `INSERT INTO domain_health
          (domain_name, status, dns_active, http_active, status_code, response_ms, addresses, checked_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(domain_name) DO UPDATE SET
            status=excluded.status, dns_active=excluded.dns_active, http_active=excluded.http_active,
            status_code=excluded.status_code, response_ms=excluded.response_ms,
            addresses=excluded.addresses, checked_at=excluded.checked_at`,
        args: [domainName, health.status, Number(health.dnsActive), Number(health.httpActive),
          health.statusCode, health.responseMs, JSON.stringify(health.addresses), health.checkedAt]
      });
    },

    async markDeliveries(channel, deliveries) {
      if (!deliveries.length) return;
      await client.batch(deliveries.map(({ key, sentAt }) => ({
        sql: "INSERT OR IGNORE INTO reminder_deliveries (channel, reminder_key, sent_at) VALUES (?, ?, ?)",
        args: [channel, key, sentAt]
      })), "write");
    },

    async saveSubscription(subscription) {
      await client.execute({
        sql: `INSERT INTO push_subscriptions (endpoint, subscription, created_at) VALUES (?, ?, ?)
          ON CONFLICT(endpoint) DO UPDATE SET subscription=excluded.subscription`,
        args: [subscription.endpoint, JSON.stringify(subscription), new Date().toISOString()]
      });
    },

    async deleteSubscriptions(endpoints) {
      if (!endpoints.length) return;
      await client.batch(endpoints.map((endpoint) => ({
        sql: "DELETE FROM push_subscriptions WHERE endpoint = ?",
        args: [endpoint]
      })), "write");
    }
  };
}
