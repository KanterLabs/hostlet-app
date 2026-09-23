const FRONTEND_RELEASE_ID = "frontend-v1";
const release = document.querySelector("#release");
const items = document.querySelector("#items");
const status = document.querySelector("#status");

function render(payload) {
  release.textContent = `${FRONTEND_RELEASE_ID} using ${payload.api_version || "api-v1"}`;
  items.replaceChildren(...(payload.items || []).map((item) => {
    const row = document.createElement("li");
    row.dataset.itemId = String(item.id);
    row.textContent = item.name;
    return row;
  }));
}

async function refresh() {
  const response = await fetch("/api/items", { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`items request failed: ${response.status}`);
  render(await response.json());
}

document.querySelector("#item-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  status.textContent = "Saving…";
  const name = document.querySelector("#item-name").value;
  const response = await fetch("/api/items", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, client_release: FRONTEND_RELEASE_ID }),
  });
  if (!response.ok) throw new Error(`create request failed: ${response.status}`);
  document.querySelector("#item-name").value = "";
  status.textContent = "Saved";
  await refresh();
});

refresh().catch((error) => { status.textContent = error.message; });
