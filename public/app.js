const state = { domains: [], query: "", filter: "all" };
const list = document.querySelector("#domain-list");
const checkAllButton = document.querySelector("#check-all");
const toast = document.querySelector("#toast");
const domainDialog = document.querySelector("#domain-dialog");
const domainForm = document.querySelector("#domain-form");
const formError = document.querySelector("#domain-form-error");
const pushButton = document.querySelector("#push-toggle");
const pushStatus = document.querySelector("#push-status");
const installButton = document.querySelector("#install-app");
let serviceWorkerRegistration;
let installPrompt;
const money = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const dateFormat = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

function daysUntil(value) {
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.ceil((new Date(`${value}T00:00:00Z`) - today) / 86400000);
}

function urgency(days) {
  if (days < 0) return "expired";
  if (days <= 30) return "critical";
  if (days <= 90) return "upcoming";
  return "safe";
}

function notify(message, isError = false) {
  toast.textContent = message;
  toast.className = `toast show${isError ? " error" : ""}`;
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => toast.className = "toast", 3500);
}

function updateSummary() {
  const checked = state.domains.filter((domain) => domain.health?.status);
  const active = checked.filter((domain) => domain.health.status === "active").length;
  const renewSoon = state.domains.filter((domain) => daysUntil(domain.expiresAt) <= 90).length;
  const totalCost = state.domains.reduce((sum, domain) => sum + domain.price, 0);
  document.querySelector("#total-count").textContent = state.domains.length;
  document.querySelector("#active-count").textContent = checked.length ? active : "—";
  document.querySelector("#active-caption").textContent = checked.length ? `${active} of ${checked.length} checked sites` : "Not yet checked";
  document.querySelector("#renew-count").textContent = renewSoon;
  document.querySelector("#annual-cost").textContent = money.format(totalCost);
  const latest = checked.map((domain) => domain.health.checkedAt).sort().at(-1);
  if (latest) document.querySelector("#last-global-check").textContent = `Last scan ${new Date(latest).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}`;
}

function filteredDomains() {
  return state.domains.filter((domain) => {
    if (!domain.name.includes(state.query.toLowerCase())) return false;
    const status = domain.health?.status;
    if (state.filter === "active") return status === "active";
    if (state.filter === "inactive") return status === "inactive" || status === "dns-only";
    if (state.filter === "renew-soon") return daysUntil(domain.expiresAt) <= 90;
    return true;
  });
}

function render() {
  updateSummary();
  const domains = filteredDomains();
  document.querySelector("#result-count").textContent = `${domains.length} domain${domains.length === 1 ? "" : "s"}`;
  if (!domains.length) {
    list.innerHTML = '<tr><td colspan="5" class="loading">No domains match this view.</td></tr>';
    return;
  }
  list.innerHTML = domains.map((domain) => {
    const days = daysUntil(domain.expiresAt);
    const status = domain.health?.status || "unchecked";
    const statusLabel = status === "dns-only" ? "DNS only" : status[0].toUpperCase() + status.slice(1);
    const dayLabel = days < 0 ? `${Math.abs(days)} days overdue` : days === 0 ? "Due today" : `${days} days left`;
    return `<tr>
      <td><div class="domain-cell"><span class="domain-icon">${domain.name[0]}</span><div><span class="domain-name">${domain.name}</span><span class="domain-since">Since ${new Date(`${domain.registeredAt}T00:00:00Z`).getUTCFullYear()}</span></div></div></td>
      <td><span class="badge ${status}">${statusLabel}</span>${domain.health?.responseMs ? `<span class="domain-since">${domain.health.responseMs} ms · HTTP ${domain.health.statusCode}</span>` : ""}</td>
      <td><div class="renewal ${urgency(days)}"><strong>${dateFormat.format(new Date(`${domain.expiresAt}T00:00:00Z`))}</strong><small>${dayLabel}</small></div></td>
      <td><strong>${money.format(domain.price)}</strong><span class="domain-since">per year</span></td>
      <td><button class="row-action" data-check="${domain.name}" title="Check ${domain.name}" aria-label="Check ${domain.name}">↻</button></td>
    </tr>`;
  }).join("");
}

async function load() {
  try {
    const response = await fetch("/api/domains");
    if (!response.ok) throw new Error("Could not load domains");
    state.domains = await response.json();
    render();
  } catch (error) {
    list.innerHTML = `<tr><td colspan="5" class="loading">${error.message}</td></tr>`;
  }
}

async function runCheck(domain) {
  const selector = domain ? `[data-check="${domain}"]` : "[data-check]";
  document.querySelectorAll(selector).forEach((button) => button.disabled = true);
  if (!domain) checkAllButton.disabled = true;
  try {
    const response = await fetch(domain ? `/api/domains/${domain}/check` : "/api/domains/check-all", { method: "POST" });
    if (!response.ok) throw new Error("Health check failed");
    if (domain) {
      const updated = await response.json();
      const index = state.domains.findIndex((item) => item.name === domain);
      state.domains[index] = updated;
    } else {
      state.domains = await response.json();
    }
    render();
    notify(domain ? `${domain} check complete` : "All domain checks complete");
  } catch (error) {
    notify(error.message, true);
  } finally {
    checkAllButton.disabled = false;
    document.querySelectorAll(selector).forEach((button) => button.disabled = false);
  }
}

document.querySelector("#search").addEventListener("input", (event) => { state.query = event.target.value.trim(); render(); });
document.querySelector("#filter").addEventListener("change", (event) => { state.filter = event.target.value; render(); });
checkAllButton.addEventListener("click", () => runCheck());
list.addEventListener("click", (event) => { const button = event.target.closest("[data-check]"); if (button) runCheck(button.dataset.check); });
document.querySelector("#menu-button").addEventListener("click", () => document.querySelector(".sidebar").classList.toggle("open"));
document.querySelector("#email-test").addEventListener("click", async (event) => {
  event.currentTarget.disabled = true;
  try {
    const response = await fetch("/api/reminders/test", { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    notify("Test reminder sent");
  } catch (error) { notify(error.message, true); }
  finally { event.currentTarget.disabled = false; }
});

function openDomainForm() {
  domainForm.reset();
  domainForm.elements.registeredAt.value = new Date().toISOString().slice(0, 10);
  formError.classList.remove("visible");
  domainDialog.showModal();
  domainForm.elements.name.focus();
}

document.querySelector("#open-add-domain").addEventListener("click", openDomainForm);
document.querySelector("#close-add-domain").addEventListener("click", () => domainDialog.close());
document.querySelector("#cancel-add-domain").addEventListener("click", () => domainDialog.close());
domainDialog.addEventListener("click", (event) => {
  if (event.target === domainDialog) domainDialog.close();
});
domainForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = document.querySelector("#save-domain");
  const values = new FormData(domainForm);
  const payload = {
    name: values.get("name"),
    registeredAt: values.get("registeredAt"),
    expiresAt: values.get("expiresAt"),
    price: values.get("price")
  };
  submitButton.disabled = true;
  formError.classList.remove("visible");
  try {
    const response = await fetch("/api/domains", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const domain = await response.json();
    if (!response.ok) throw new Error(domain.error || "Could not add domain");
    state.domains.push(domain);
    state.domains.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
    render();
    domainDialog.close();
    notify(`${domain.name} added to your portfolio`);
  } catch (error) {
    formError.textContent = error.message;
    formError.classList.add("visible");
  } finally {
    submitButton.disabled = false;
  }
});

function applicationServerKey(value) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

async function updatePushState() {
  if (!serviceWorkerRegistration || !("PushManager" in window)) {
    pushButton.disabled = true;
    pushStatus.textContent = "Push notifications are not supported by this browser.";
    return;
  }
  const subscription = await serviceWorkerRegistration.pushManager.getSubscription();
  pushButton.classList.toggle("enabled", Boolean(subscription));
  pushButton.textContent = subscription ? "Notifications enabled" : "Enable notifications";
  pushStatus.textContent = subscription
    ? "Renewal and downtime alerts are active on this device."
    : "Get renewal and downtime alerts on this device.";
}

pushButton.addEventListener("click", async () => {
  pushButton.disabled = true;
  try {
    const existing = await serviceWorkerRegistration.pushManager.getSubscription();
    if (existing) {
      await fetch("/api/push/unsubscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: existing.endpoint })
      });
      await existing.unsubscribe();
      notify("Notifications disabled on this device");
    } else {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Notification permission was not granted");
      const configResponse = await fetch("/api/push/config");
      const config = await configResponse.json();
      if (!configResponse.ok || !config.configured) throw new Error(config.error || "Push notifications are not configured");
      const subscription = await serviceWorkerRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(config.publicKey)
      });
      const response = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(subscription)
      });
      if (!response.ok) {
        const result = await response.json();
        await subscription.unsubscribe();
        throw new Error(result.error || "Could not enable notifications");
      }
      await serviceWorkerRegistration.showNotification("Domain Watch is ready", {
        body: "Renewal and domain-down alerts are enabled on this device.",
        icon: "/icons/icon-192.png",
        tag: "push-enabled"
      });
      notify("Notifications enabled");
    }
    await updatePushState();
  } catch (error) {
    notify(error.message, true);
  } finally {
    pushButton.disabled = false;
  }
});

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  installButton.hidden = false;
});
installButton.addEventListener("click", async () => {
  if (!installPrompt) return;
  await installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  installButton.hidden = true;
});
window.addEventListener("appinstalled", () => { installButton.hidden = true; notify("Domain Watch installed"); });

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js")
    .then(async (registration) => { serviceWorkerRegistration = registration; await updatePushState(); })
    .catch(() => {
      pushButton.disabled = true;
      pushStatus.textContent = "The offline service could not be started.";
    });
} else {
  pushButton.disabled = true;
  pushStatus.textContent = "This browser does not support app installation or push alerts.";
}

load();
