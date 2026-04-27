const appState = {
  containers: [],
  routes: [],
  certificates: [],
  selectedRoute: null,
  meta: null,
};

const $ = (selector) => document.querySelector(selector);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showMessage(text, type = "info") {
  const message = $("#app-view").hidden ? $("#login-message") : $("#message");
  message.textContent = text;
  message.className = `message ${type}`;
  message.hidden = false;
  window.setTimeout(() => {
    message.hidden = true;
  }, 6000);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

async function checkAuth() {
  try {
    await api("/api/me");
    $("#login-view").hidden = true;
    $("#app-view").hidden = false;
    $("#login-message").hidden = true;
    await refreshAll();
    return true;
  } catch {
    $("#login-view").hidden = false;
    $("#app-view").hidden = true;
    return false;
  }
}

function renderMeta(meta) {
  const version = meta?.version || "dev";
  const build = meta?.build || "local";
  const label = `v${version} (${build})`;
  document.title = `timptr panel ${label}`;
  document.querySelectorAll("[data-version-label]").forEach((element) => {
    element.textContent = label;
  });
}

async function loadMeta() {
  try {
    appState.meta = await api("/api/meta");
    renderMeta(appState.meta);
  } catch {
    renderMeta({ version: "dev", build: "unknown" });
  }
}

async function login(event) {
  event.preventDefault();
  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ password: $("#password").value }),
    });
    $("#password").value = "";
    const authenticated = await checkAuth();
    if (!authenticated) {
      showMessage(
        "Пароль принят, но браузер не сохранил сессию. Если панель открыта по HTTP, проверьте COOKIE_SECURE=false в /opt/panel/.env и перезапустите docker compose.",
        "error",
      );
    }
  } catch (error) {
    showMessage(error.message, "error");
  }
}

async function logout() {
  await api("/api/logout", { method: "POST" });
  $("#login-view").hidden = false;
  $("#app-view").hidden = true;
}

function statusBadge(active) {
  return `<span class="badge ${active ? "ok" : "muted"}">${active ? "активно" : "неактивно"}</span>`;
}

function renderPorts(ports) {
  if (!ports?.length) return "<span class=\"muted-text\">нет опубликованных портов</span>";
  return ports
    .map((port) => {
      const host = port.hostPort ? `${port.hostIp || "0.0.0.0"}:${port.hostPort}` : "не опубликован";
      const privatePort = port.privatePort ? `${port.privatePort}/${port.type}` : port.containerPort;
      return `<span class="pill">${escapeHtml(host)} -> ${escapeHtml(privatePort)}</span>`;
    })
    .join("");
}

function renderContainers() {
  const body = $("#containers-body");
  body.innerHTML = appState.containers.length
    ? appState.containers.map(
      (container) => `
        <tr>
          <td><strong>${escapeHtml(container.names.join(", "))}</strong><div class="subtle">${escapeHtml(container.image)}</div></td>
          <td>${statusBadge(container.state === "running")}<div class="subtle">${container.status}</div></td>
          <td><div class="pill-list">${renderPorts(container.ports)}</div></td>
          <td class="actions">
            <button data-action="start" data-id="${escapeHtml(container.id)}" ${container.state === "running" ? "disabled" : ""}>Старт</button>
            <button data-action="stop" data-id="${escapeHtml(container.id)}" ${container.state !== "running" ? "disabled" : ""}>Стоп</button>
            <button data-action="restart" data-id="${escapeHtml(container.id)}">Рестарт</button>
          </td>
        </tr>
      `,
    )
    .join("")
    : "<tr><td colspan=\"4\" class=\"muted-text\">Контейнеры не найдены</td></tr>";
}

function renderRoutes() {
  const body = $("#routes-body");
  body.innerHTML = appState.routes.length
    ? appState.routes.map(
      (route) => `
        <tr>
          <td><strong>${escapeHtml(route.domain)}</strong><div class="subtle">${escapeHtml(route.file)}</div></td>
          <td>${route.enabled ? statusBadge(true) : "<span class=\"badge warning\">disabled</span>"}</td>
          <td><span class="pill">${escapeHtml(route.target || "не найден")}</span></td>
          <td>${route.certificate ? escapeHtml(route.certificate.summary) : "<span class=\"muted-text\">нет данных</span>"}</td>
          <td class="actions">
            <button data-route-edit="${escapeHtml(route.domain)}">Изменить</button>
            <button data-cert-domain="${escapeHtml(route.domain)}">Сертификат</button>
          </td>
        </tr>
      `,
    )
    .join("")
    : "<tr><td colspan=\"5\" class=\"muted-text\">Маршруты не найдены</td></tr>";
}

function renderCertificates() {
  const body = $("#certificates-body");
  body.innerHTML = appState.certificates.length
    ? appState.certificates.map((cert) => `
        <tr>
          <td><strong>${escapeHtml(cert.name)}</strong><div class="subtle">${escapeHtml(cert.domains.join(", "))}</div></td>
          <td>${escapeHtml(cert.domains.join(", ") || "нет данных")}</td>
          <td>${escapeHtml(cert.expiry || "нет данных")}</td>
          <td><code>${escapeHtml(cert.certificatePath || "")}</code></td>
          <td class="actions">
            <button data-cert-domain="${escapeHtml(cert.domains[0] || cert.name)}">Перевыпуск</button>
          </td>
        </tr>
      `).join("")
    : "<tr><td colspan=\"5\" class=\"muted-text\">Сертификаты не найдены</td></tr>";
}

function routeByDomain(domain) {
  return appState.routes.find((route) => route.domain === domain);
}

function openRouteDialog(route = null) {
  appState.selectedRoute = route;
  $("#route-domain").value = route?.domain || "";
  $("#route-domain").disabled = Boolean(route);
  $("#route-port").value = route?.targetPort || "";
  $("#route-dialog-title").textContent = route ? "Изменить маршрут" : "Новый маршрут";
  $("#route-dialog").showModal();
}

function closeRouteDialog() {
  $("#route-dialog").close();
  appState.selectedRoute = null;
  $("#route-domain").disabled = false;
}

function openCertDialog(domain) {
  $("#cert-domain").value = domain;
  $("#cert-email").value = "";
  $("#cert-dialog").showModal();
}

async function refreshAll() {
  const [containers, routes, certificates] = await Promise.all([
    api("/api/docker/containers"),
    api("/api/nginx/routes"),
    api("/api/certificates"),
  ]);
  appState.containers = containers.containers;
  appState.routes = routes.routes;
  appState.certificates = certificates.certificates;
  renderContainers();
  renderRoutes();
  renderCertificates();
}

async function handleContainerAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  try {
    button.disabled = true;
    await api(`/api/docker/containers/${button.dataset.id}/${button.dataset.action}`, { method: "POST" });
    showMessage("Команда Docker выполнена", "success");
    await refreshAll();
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function saveRoute(event) {
  event.preventDefault();
  const domain = $("#route-domain").value.trim();
  const port = Number($("#route-port").value);
  try {
    await api("/api/nginx/routes", {
      method: "POST",
      body: JSON.stringify({ domain, port }),
    });
    closeRouteDialog();
    showMessage("Маршрут сохранен и nginx перезагружен", "success");
    await refreshAll();
  } catch (error) {
    showMessage(error.message, "error");
  }
}

async function issueCertificate(event) {
  event.preventDefault();
  const domain = $("#cert-domain").value.trim();
  const email = $("#cert-email").value.trim();
  try {
    await api(`/api/certificates/${encodeURIComponent(domain)}/issue`, {
      method: "POST",
      body: JSON.stringify({ email }),
    });
    $("#cert-dialog").close();
    showMessage("Certbot завершил выпуск сертификата", "success");
    await refreshAll();
  } catch (error) {
    showMessage(error.message, "error");
  }
}

async function renewAllCertificates() {
  try {
    await api("/api/certificates/renew", {
      method: "POST",
      body: JSON.stringify({}),
    });
    showMessage("Certbot renew завершен", "success");
    await refreshAll();
  } catch (error) {
    showMessage(error.message, "error");
  }
}

document.addEventListener("click", (event) => {
  const editRoute = event.target.closest("button[data-route-edit]");
  if (editRoute) openRouteDialog(routeByDomain(editRoute.dataset.routeEdit));

  const certButton = event.target.closest("button[data-cert-domain]");
  if (certButton) openCertDialog(certButton.dataset.certDomain);
});

$("#login-form").addEventListener("submit", login);
$("#logout").addEventListener("click", logout);
$("#refresh").addEventListener("click", () => refreshAll().catch((error) => showMessage(error.message, "error")));
$("#new-route").addEventListener("click", () => openRouteDialog());
$("#route-form").addEventListener("submit", saveRoute);
$("#route-cancel").addEventListener("click", closeRouteDialog);
$("#cert-form").addEventListener("submit", issueCertificate);
$("#cert-cancel").addEventListener("click", () => $("#cert-dialog").close());
$("#containers-body").addEventListener("click", handleContainerAction);
$("#renew-all").addEventListener("click", renewAllCertificates);

loadMeta().finally(checkAuth);
