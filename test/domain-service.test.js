import test from "node:test";
import assert from "node:assert/strict";
import { daysUntil, normalizeDomain, reminderKey, remindersDue, renewalState } from "../lib/domain-service.js";

const now = new Date("2026-06-01T12:00:00Z");

test("calculates calendar days until renewal", () => {
  assert.equal(daysUntil("2026-06-16", now), 15);
  assert.equal(daysUntil("2026-05-31", now), -1);
});

test("classifies renewal urgency", () => {
  assert.equal(renewalState("2026-05-31", now), "expired");
  assert.equal(renewalState("2026-06-16", now), "critical");
  assert.equal(renewalState("2026-08-01", now), "upcoming");
  assert.equal(renewalState("2027-01-01", now), "safe");
});

test("selects due reminders once per threshold", () => {
  const domains = [{ name: "example.com", expiresAt: "2026-06-16" }];
  assert.equal(remindersDue(domains, [30, 14, 7], {}, now).length, 1);
  const sent = { "example.com:2026-06-16:30": true };
  assert.equal(remindersDue(domains, [30, 14, 7], sent, now).length, 0);
});

test("advances to each smaller reminder threshold", () => {
  const domain = { name: "example.com", expiresAt: "2026-06-06" };
  const sent = { "example.com:2026-06-06:7": true };
  assert.equal(remindersDue([domain], [60, 30, 14, 7, 3, 1], sent, now).length, 0);
  assert.match(reminderKey(domain, [60, 30, 14, 7, 3, 1], new Date("2026-06-03T12:00:00Z")), /:3$/);
});

test("normalizes a new domain record", () => {
  assert.deepEqual(normalizeDomain({
    name: " Example.COM ",
    expiresAt: "2027-08-10",
    registeredAt: "2026-08-10",
    price: "1599"
  }), {
    name: "example.com",
    expiresAt: "2027-08-10",
    registeredAt: "2026-08-10",
    price: 1599
  });
});

test("rejects invalid domain records", () => {
  assert.throws(() => normalizeDomain({
    name: "not a domain",
    expiresAt: "2027-08-10",
    registeredAt: "2026-08-10",
    price: 899
  }), /valid domain name/);
  assert.throws(() => normalizeDomain({
    name: "example.com",
    expiresAt: "2026-08-10",
    registeredAt: "2027-08-10",
    price: 899
  }), /Purchase date/);
});
