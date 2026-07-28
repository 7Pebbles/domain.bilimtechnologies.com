import { promises as dns } from "node:dns";

export class DomainValidationError extends Error {}

export function normalizeDomain(input) {
  const name = String(input?.name || "").trim().toLowerCase();
  const domainPattern = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
  if (!domainPattern.test(name)) throw new DomainValidationError("Enter a valid domain name, such as example.com");

  const validDate = (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
    try {
      return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
    } catch {
      return false;
    }
  };
  if (!validDate(input.expiresAt)) throw new DomainValidationError("Enter a valid renewal date");
  if (!validDate(input.registeredAt)) throw new DomainValidationError("Enter a valid purchase date");
  if (input.registeredAt > input.expiresAt) throw new DomainValidationError("Purchase date must be before the renewal date");

  const price = Number(input.price);
  if (!Number.isFinite(price) || price <= 0) throw new DomainValidationError("Annual price must be greater than zero");

  return {
    name,
    expiresAt: input.expiresAt,
    price: Math.round(price * 100) / 100,
    registeredAt: input.registeredAt
  };
}

export function daysUntil(date, now = new Date()) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const expiry = new Date(`${date}T00:00:00Z`).getTime();
  return Math.ceil((expiry - today) / 86_400_000);
}

export function renewalState(date, now = new Date()) {
  const days = daysUntil(date, now);
  if (days < 0) return "expired";
  if (days <= 30) return "critical";
  if (days <= 90) return "upcoming";
  return "safe";
}

export function remindersDue(domains, thresholds, sent, now = new Date()) {
  return domains.filter((domain) => {
    const days = daysUntil(domain.expiresAt, now);
    const threshold = [...thresholds].sort((a, b) => a - b).find((value) => days <= value && days >= 0);
    return threshold !== undefined && !sent[`${domain.name}:${domain.expiresAt}:${threshold}`];
  });
}

export function reminderKey(domain, thresholds, now = new Date()) {
  const days = daysUntil(domain.expiresAt, now);
  const threshold = [...thresholds].sort((a, b) => a - b).find((value) => days <= value && days >= 0);
  return threshold === undefined ? null : `${domain.name}:${domain.expiresAt}:${threshold}`;
}

export async function checkDomain(domain, timeoutMs = 8_000) {
  const checkedAt = new Date().toISOString();
  let dnsActive = false;
  let addresses = [];

  try {
    addresses = await dns.resolve4(domain);
    dnsActive = addresses.length > 0;
  } catch {
    try {
      addresses = await dns.resolve6(domain);
      dnsActive = addresses.length > 0;
    } catch {
      dnsActive = false;
    }
  }

  let httpActive = false;
  let statusCode = null;
  let responseMs = null;

  if (dnsActive) {
    for (const protocol of ["https", "http"]) {
      const started = Date.now();
      try {
        const response = await fetch(`${protocol}://${domain}`, {
          method: "HEAD",
          redirect: "follow",
          signal: AbortSignal.timeout(timeoutMs),
          headers: { "user-agent": "BilimDomainWatch/1.0" }
        });
        statusCode = response.status;
        responseMs = Date.now() - started;
        httpActive = response.status < 500;
        if (httpActive) break;
      } catch {
        // Try the next protocol before marking the website unreachable.
      }
    }
  }

  return {
    status: httpActive ? "active" : dnsActive ? "dns-only" : "inactive",
    dnsActive,
    httpActive,
    statusCode,
    responseMs,
    addresses,
    checkedAt
  };
}
