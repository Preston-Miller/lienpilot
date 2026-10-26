const $ = (sel) => document.querySelector(sel);

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

async function api(path, options = {}) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let roles = [];

function showStep(n) {
  $("#step-1").classList.toggle("hidden", n !== 1);
  $("#step-2").classList.toggle("hidden", n !== 2);
  $("#step-pill-1").classList.toggle("active", n === 1);
  $("#step-pill-2").classList.toggle("active", n === 2);
  $("#step-pill-1").classList.toggle("done", n === 2);
}

function renderRoles() {
  $("#role-fields").innerHTML = roles.map((r) => `
    <fieldset class="role-field">
      <legend>${escapeHtml(r.label)}</legend>
      <p class="hint">${escapeHtml(r.description)}</p>
      <div class="role-inputs">
        <label>
          <span>Email</span>
          <input type="email" name="email-${r.id}" value="${escapeHtml(r.email)}" placeholder="records@yourclinic.com" required autocomplete="off" />
        </label>
        <label>
          <span>Name <em>(optional)</em></span>
          <input type="text" name="name-${r.id}" value="${escapeHtml(r.name === r.label ? "" : r.name)}" placeholder="${escapeHtml(r.label)}" autocomplete="off" />
        </label>
      </div>
    </fieldset>`).join("");
}

async function load() {
  const data = await api("/api/clinic-contacts");
  roles = data.roles;
  lienCount = data.lien_count;
  renderRoles();
  $("#staff-emails").value = (data.staff || []).join("\n");
  if (data.agent_address) $("#agent-address").textContent = data.agent_address;
}

$("#contacts-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const err = $("#contacts-error");
  err.classList.add("hidden");
  const contacts = roles.map((r) => ({
    id: r.id,
    email: form[`email-${r.id}`].value.trim(),
    name: form[`name-${r.id}`].value.trim(),
  }));
  const btn = $("#save-contacts");
  btn.disabled = true;
  try {
    await api("/api/clinic-contacts", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contacts, staff: $("#staff-emails").value }),
    });
    roles = roles.map((r) => ({ ...r, ...contacts.find((c) => c.id === r.id) }));
    showStep(2);
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove("hidden");
  } finally {
    btn.disabled = false;
  }
});

$("#back-to-contacts").addEventListener("click", () => showStep(1));

let lienCount = 0;

async function uploadCsv(file) {
  if (lienCount > 0 && !window.confirm(
    `This replaces all ${lienCount} existing lien${lienCount === 1 ? "" : "s"} (and their history) with ${file.name}. Continue?`
  )) return;
  const box = $("#csv-result");
  box.classList.remove("hidden", "error");
  box.textContent = `Importing ${file.name}…`;
  try {
    const data = await api("/api/import-liens?mode=replace", {
      method: "POST",
      headers: { "Content-Type": "text/csv" },
      body: await file.text(),
    });
    const problems = (data.errors || []).slice(0, 8)
      .map((e) => `<li>Line ${e.line}: ${escapeHtml(e.error)}</li>`).join("");
    box.innerHTML =
      (data.replaced ? `Replaced ${data.replaced} existing lien${data.replaced === 1 ? "" : "s"}. ` : "") +
      `<strong>${data.imported}</strong> lien${data.imported === 1 ? "" : "s"} imported from ${escapeHtml(file.name)}` +
      (data.skipped ? `, ${data.skipped} skipped.<ul>${problems}</ul>` : ".") +
      (data.imported === 0 && lienCount > 0 ? " Existing liens were left as they were." : "");
    if (data.imported > 0) lienCount = data.imported;
    box.classList.toggle("error", data.imported === 0);
  } catch (ex) {
    box.textContent = `Import failed: ${ex.message}`;
    box.classList.add("error");
  }
}

$("#onboard-csv").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  e.target.value = ""; // allow re-uploading the same file
  if (file) uploadCsv(file);
});

const drop = $("#drop-zone");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("dragging"); });
drop.addEventListener("dragleave", () => drop.classList.remove("dragging"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("dragging");
  const file = e.dataTransfer.files?.[0];
  if (file) uploadCsv(file);
});

load().catch((ex) => {
  $("#role-fields").innerHTML = `<p class="onboard-error">Couldn't load setup: ${escapeHtml(ex.message)}</p>`;
});
