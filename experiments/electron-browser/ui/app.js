const $ = (id) => document.getElementById(id);
let current = { tabs: [], activeId: null };
let noticeTimer;
function notice(message) {
  $("notice").textContent = message;
  $("notice").style.display = "block";
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    $("notice").style.display = "none";
  }, 7000);
}
async function send(command) {
  try {
    render(await window.colonyBrowser.command(command));
  } catch (error) {
    notice(error.message);
  }
}
function active() {
  return current.tabs.find((tab) => tab.id === current.activeId);
}
function render(state) {
  current = state;
  const tab = active();
  $("tabs").replaceChildren();
  for (const item of state.tabs) {
    const row = document.createElement("div");
    row.className = `tab${item.id === state.activeId ? " active" : ""}`;
    const select = document.createElement("button");
    select.textContent = `${item.workspace === "horizon" ? "H" : "C"} · ${item.title}`;
    select.title = item.url;
    select.setAttribute("aria-label", `${item.workspace}: ${item.title}`);
    select.onclick = () => send({ action: "select", tabId: item.id });
    const close = document.createElement("button");
    close.textContent = "×";
    close.setAttribute("aria-label", `Close ${item.title}`);
    close.onclick = () => send({ action: "close", tabId: item.id });
    row.append(select, close);
    $("tabs").append(row);
  }
  if (document.activeElement !== $("address"))
    $("address").value = tab?.url || "";
  $("account").textContent =
    tab?.workspace === "horizon" ? "Horizon Labs" : "Colony";
  $("controller").textContent =
    tab?.controller === "You"
      ? "You are in control"
      : tab?.controller || "No tab open";
  $("grant").textContent = state.lastGrantFile || "No tab shared";
  $("empty").hidden = !!tab;
  for (const id of ["share", "takeover", "back", "reload"])
    $(id).disabled = !tab;
}
$("navigation").onsubmit = (event) => {
  event.preventDefault();
  const value = $("address").value.trim();
  const url = value.includes("://") ? value : `https://${value}`;
  send(
    active()
      ? { action: "navigate", tabId: current.activeId, url }
      : { action: "create", workspace: $("business").value, url },
  );
};
function create(url) {
  return send({ action: "create", workspace: $("business").value, url });
}
$("instagram").onclick = () => create("https://www.instagram.com/");
$("website").onclick = () => create("https://colony.ainative.ventures/");
$("new").onclick = () => create("https://colony.ainative.ventures/");
for (const action of ["back", "reload", "takeover"])
  $(action).onclick = () => send({ action, tabId: current.activeId });
$("share").onclick = () =>
  send({
    action: "grant",
    tabId: current.activeId,
    worker: $("worker").value,
    mode: $("mode").value,
  });
window.colonyBrowser.subscribe(render);
send({ action: "state" });
