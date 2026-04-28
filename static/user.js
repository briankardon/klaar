/* Klaar - User settings page */

const API = "/api";
const MIN_PASSWORD_LENGTH = 6;

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    window.location.href = "/";
    return null;
  }
  if (res.status === 204) return { _no_content: true };
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return { error: "unexpected response", _status: res.status };
  const data = await res.json();
  data._status = res.status;
  return data;
}

function showMsg(el, text, ok) {
  el.textContent = text;
  el.className = ok ? "msg msg-ok" : "msg msg-err";
  el.classList.remove("hidden");
}

function hideMsg(el) {
  el.classList.add("hidden");
}

// --- State ---
let currentUser = null;

// --- Confirm dialog ---
function confirmDialog(title, text, extraHtml) {
  return new Promise((resolve) => {
    const overlay = document.getElementById("confirm-overlay");
    document.getElementById("confirm-title").textContent = title;
    document.getElementById("confirm-text").textContent = text;
    const extraEl = document.getElementById("confirm-extra");
    extraEl.innerHTML = extraHtml || "";
    overlay.classList.remove("hidden");

    function cleanup(result) {
      overlay.classList.add("hidden");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      resolve(result);
    }

    const okBtn = document.getElementById("confirm-ok");
    const cancelBtn = document.getElementById("confirm-cancel");

    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
  });
}

// --- Logout ---
document.getElementById("btn-logout").addEventListener("click", async () => {
  await api("/logout", { method: "POST" });
  window.location.href = "/";
});

// --- Load current user ---
async function loadCurrentUser() {
  const data = await api("/me");
  if (!data || data.error) return;
  currentUser = data;
  document.getElementById("header-user").textContent = data.display_name || data.username;
  document.getElementById("profile-username").textContent = data.username;
  document.getElementById("profile-display-name").value = data.display_name || "";

  if (data.admin) {
    document.getElementById("admin-section").classList.remove("hidden");
    loadUsers();
  }

  loadContacts();
  loadCalendarUrl();
  loadApiTokens();
  loadBackups();
}

// --- Daily backups ---
function formatBackupSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(2) + " MB";
}

async function loadBackups() {
  const data = await api("/me/backups");
  if (!data || data.error) return;
  const tbody = document.getElementById("backups-list");
  const table = document.getElementById("backups-table");
  const empty = document.getElementById("backups-empty");
  tbody.innerHTML = "";
  const backups = data.backups || [];
  if (backups.length === 0) {
    table.classList.add("hidden");
    empty.classList.remove("hidden");
    return;
  }
  table.classList.remove("hidden");
  empty.classList.add("hidden");
  for (const b of backups) {
    const tr = document.createElement("tr");
    const dateTd = document.createElement("td");
    dateTd.textContent = b.date;
    tr.appendChild(dateTd);
    const sizeTd = document.createElement("td");
    sizeTd.textContent = formatBackupSize(b.size);
    tr.appendChild(sizeTd);
    const actionsTd = document.createElement("td");
    actionsTd.className = "actions";
    const browseBtn = document.createElement("button");
    browseBtn.className = "btn btn-primary btn-small";
    browseBtn.textContent = "Browse";
    browseBtn.addEventListener("click", () => browseBackup(b.date));
    actionsTd.appendChild(browseBtn);
    if (currentUser && currentUser.admin) {
      const dlBtn = document.createElement("a");
      dlBtn.className = "btn btn-cancel btn-small";
      dlBtn.href = "/api/admin/backups/" + encodeURIComponent(b.date) + "/download";
      dlBtn.textContent = "Download";
      dlBtn.title = "Download raw archive (admin)";
      dlBtn.style.textDecoration = "none";
      dlBtn.style.display = "inline-block";
      actionsTd.appendChild(dlBtn);
    }
    tr.appendChild(actionsTd);
    tbody.appendChild(tr);
  }
}

async function browseBackup(date) {
  const overlay = document.getElementById("backup-browse-overlay");
  const titleEl = document.getElementById("backup-browse-title");
  const listEl = document.getElementById("backup-browse-list");
  const msgEl = document.getElementById("backup-browse-msg");
  titleEl.textContent = "Backup from " + date;
  listEl.innerHTML = "<p style='font-size:0.85rem; color:var(--text-muted);'>Loading…</p>";
  hideMsg(msgEl);
  overlay.classList.remove("hidden");
  const data = await api("/me/backups/" + encodeURIComponent(date) + "/lists");
  if (!data || data.error) {
    listEl.innerHTML = "";
    showMsg(msgEl, data?.error || "Failed to read backup.", false);
    return;
  }
  const lists = data.lists || [];
  listEl.innerHTML = "";
  if (lists.length === 0) {
    listEl.innerHTML = "<p style='font-size:0.9rem; color:var(--text-muted);'>No lists of yours found in this backup.</p>";
    return;
  }
  let othersHeaderInserted = false;
  for (const l of lists) {
    // For admins viewing a backup that contains other users' lists, drop a
    // section header just before the first non-own row.
    if (!l.is_mine && !othersHeaderInserted) {
      const header = document.createElement("div");
      header.textContent = "Other users' lists (read-only)";
      header.style.cssText = "font-size:0.8rem; font-weight:600; color:var(--text-secondary); margin:0.8rem 0 0.3rem; padding-top:0.5rem; border-top:1px solid var(--border-light);";
      listEl.appendChild(header);
      othersHeaderInserted = true;
    }
    const row = document.createElement("div");
    row.style.cssText = "display:flex; align-items:center; gap:0.6rem; padding:0.5rem 0; border-bottom:1px solid var(--border-lighter);";
    const info = document.createElement("div");
    info.style.cssText = "flex:1; min-width:0;";
    const name = document.createElement("div");
    name.textContent = l.name;
    name.style.cssText = "font-weight:500; word-break:break-word;";
    if (!l.is_mine) name.style.color = "var(--text-secondary)";
    info.appendChild(name);
    const meta = document.createElement("div");
    meta.style.cssText = "font-size:0.78rem; color:var(--text-muted);";
    const ownerSpan = l.is_mine
      ? ""
      : `Owner: <strong>${l.owner_name}</strong> &middot; `;
    const exists = l.still_exists
      ? `<span style='color:var(--accent-green);'>✓ still in ${l.is_mine ? "your" : "their"} lists</span>`
      : `<span style='color:var(--accent-red);'>✗ not in current lists</span>`;
    meta.innerHTML = `${ownerSpan}${l.item_count} item${l.item_count===1?"":"s"}, ${l.tag_count} tag${l.tag_count===1?"":"s"} &middot; ${exists}`;
    info.appendChild(meta);
    row.appendChild(info);
    if (l.can_restore) {
      const restoreBtn = document.createElement("button");
      restoreBtn.className = "btn btn-primary btn-small";
      restoreBtn.textContent = "Restore as new list";
      restoreBtn.addEventListener("click", () => restoreFromBackup(date, l.id, restoreBtn));
      row.appendChild(restoreBtn);
    }
    listEl.appendChild(row);
  }
}

async function restoreFromBackup(date, listId, btn) {
  const msgEl = document.getElementById("backup-browse-msg");
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Restoring…";
  const res = await api("/me/backups/" + encodeURIComponent(date) + "/restore", {
    method: "POST",
    body: { list_id: listId },
  });
  if (!res || res.error) {
    btn.disabled = false;
    btn.textContent = original;
    showMsg(msgEl, res?.error || "Restore failed.", false);
    return;
  }
  btn.textContent = "Restored ✓";
  showMsg(msgEl, `Restored as "${res.name}".`, true);
}

document.getElementById("backup-browse-close").addEventListener("click", () => {
  document.getElementById("backup-browse-overlay").classList.add("hidden");
});

// --- API tokens (per-list, for AI / external write access) ---
async function loadApiTokens() {
  const data = await api("/me/api-tokens");
  if (!data || data.error) return;
  renderApiTokens(data.tokens || []);
}

function renderApiTokens(tokens) {
  const tbody = document.getElementById("api-tokens-list");
  const table = document.getElementById("api-tokens-table");
  const empty = document.getElementById("api-tokens-empty");
  tbody.innerHTML = "";
  if (tokens.length === 0) {
    table.classList.add("hidden");
    empty.classList.remove("hidden");
    return;
  }
  table.classList.remove("hidden");
  empty.classList.add("hidden");
  for (const t of tokens) {
    const tr = document.createElement("tr");
    const created = t.created_at ? new Date(t.created_at).toLocaleString() : "—";
    const lastUsed = t.last_used_at ? new Date(t.last_used_at).toLocaleString() : "never";
    const nameTd = document.createElement("td");
    const nameLink = document.createElement("a");
    nameLink.href = "/#list=" + encodeURIComponent(t.list_id);
    nameLink.textContent = t.list_name || "(unnamed)";
    nameLink.style.color = "inherit";
    nameTd.appendChild(nameLink);
    tr.appendChild(nameTd);

    const createdTd = document.createElement("td");
    createdTd.textContent = created;
    tr.appendChild(createdTd);

    const lastUsedTd = document.createElement("td");
    lastUsedTd.textContent = lastUsed;
    tr.appendChild(lastUsedTd);

    const actionsTd = document.createElement("td");
    actionsTd.className = "actions";
    const revokeBtn = document.createElement("button");
    revokeBtn.className = "btn btn-danger btn-small";
    revokeBtn.textContent = "Revoke";
    revokeBtn.addEventListener("click", () => revokeApiToken(t.list_id, t.list_name));
    actionsTd.appendChild(revokeBtn);
    tr.appendChild(actionsTd);

    tbody.appendChild(tr);
  }
}

async function revokeApiToken(listId, listName) {
  const ok = await confirmDialog(
    "Revoke API token?",
    `Anything currently using the API token for "${listName}" will lose access immediately. This cannot be undone (a new token can be generated, but the old one is gone).`
  );
  if (!ok) return;
  const msgEl = document.getElementById("api-tokens-msg");
  const res = await api(`/lists/${listId}/api-token`, { method: "DELETE" });
  if (res && res.error) {
    showMsg(msgEl, res.error, false);
    return;
  }
  showMsg(msgEl, `Token for "${listName}" revoked.`, true);
  setTimeout(() => hideMsg(msgEl), 2500);
  loadApiTokens();
}

// --- Calendar subscription URL ---
function calendarUrlFor(token) {
  return window.location.origin + "/calendar/" + token + ".ics";
}

async function loadCalendarUrl() {
  const data = await api("/me/calendar-token");
  if (!data || data.error) return;
  document.getElementById("calendar-url").value = calendarUrlFor(data.token);
}

document.getElementById("btn-copy-cal-url").addEventListener("click", async () => {
  const input = document.getElementById("calendar-url");
  const msgEl = document.getElementById("cal-msg");
  if (!input.value) return;
  try {
    await navigator.clipboard.writeText(input.value);
    showMsg(msgEl, "URL copied to clipboard.", true);
  } catch (e) {
    input.select();
    document.execCommand("copy");
    showMsg(msgEl, "URL copied (fallback).", true);
  }
  setTimeout(() => hideMsg(msgEl), 2500);
});

document.getElementById("btn-regen-cal-url").addEventListener("click", async () => {
  const ok = await confirmDialog(
    "Regenerate calendar URL?",
    "This invalidates the all-lists URL and every per-list URL. Any calendar app subscribed to any old URL will stop receiving updates until you re-subscribe with a new one."
  );
  if (!ok) return;
  const msgEl = document.getElementById("cal-msg");
  const data = await api("/me/calendar-token/regenerate", { method: "POST" });
  if (!data || data.error) {
    showMsg(msgEl, data?.error || "Failed to regenerate.", false);
    return;
  }
  document.getElementById("calendar-url").value = calendarUrlFor(data.token);
  showMsg(msgEl, "New URL generated.", true);
});

// --- Save display name ---
document.getElementById("btn-save-display").addEventListener("click", async () => {
  const msgEl = document.getElementById("display-msg");
  hideMsg(msgEl);
  const displayName = document.getElementById("profile-display-name").value.trim();
  if (!displayName) {
    showMsg(msgEl, "Display name cannot be empty.", false);
    return;
  }
  const data = await api("/me", {
    method: "PATCH",
    body: { display_name: displayName },
  });
  if (!data || data.error) {
    showMsg(msgEl, data?.error || "Failed to update.", false);
    return;
  }
  showMsg(msgEl, "Display name updated.", true);
  document.getElementById("header-user").textContent = data.display_name;
  currentUser.display_name = data.display_name;
});

// --- Change password ---
document.getElementById("btn-change-pw").addEventListener("click", async () => {
  const msgEl = document.getElementById("pw-msg");
  hideMsg(msgEl);
  const currentPw = document.getElementById("pw-current").value;
  const newPw = document.getElementById("pw-new").value;
  const confirmPw = document.getElementById("pw-confirm").value;

  if (!currentPw) {
    showMsg(msgEl, "Current password is required.", false);
    return;
  }
  if (newPw.length < MIN_PASSWORD_LENGTH) {
    showMsg(msgEl, `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`, false);
    return;
  }
  if (newPw !== confirmPw) {
    showMsg(msgEl, "New passwords do not match.", false);
    return;
  }

  const data = await api("/me", {
    method: "PATCH",
    body: { current_password: currentPw, new_password: newPw },
  });
  if (!data || data.error) {
    showMsg(msgEl, data?.error || "Failed to change password.", false);
    return;
  }
  showMsg(msgEl, "Password changed successfully.", true);
  document.getElementById("pw-current").value = "";
  document.getElementById("pw-new").value = "";
  document.getElementById("pw-confirm").value = "";
});

// --- Delete account ---
document.getElementById("btn-delete-account").addEventListener("click", async () => {
  const ok = await confirmDialog(
    "Delete your account?",
    "This will permanently delete your account and all your lists. Enter your password to confirm.",
    '<div class="form-group" style="margin-top:0.5rem;"><label for="delete-pw-input">Password</label><input class="field-input" type="password" id="delete-pw-input" autocomplete="current-password"></div>'
  );
  if (!ok) return;

  const password = document.getElementById("delete-pw-input")?.value || "";
  if (!password) return;

  const data = await api("/me", {
    method: "DELETE",
    body: { password },
  });
  if (data && data.error) {
    alert(data.error);
    return;
  }
  window.location.href = "/";
});

// --- Admin: load users ---
async function loadUsers() {
  const users = await api("/users");
  if (!users || users.error) return;
  const tbody = document.getElementById("admin-user-list");
  tbody.innerHTML = "";
  for (const u of users) {
    const tr = document.createElement("tr");

    const tdUser = document.createElement("td");
    tdUser.textContent = u.username;
    tr.appendChild(tdUser);

    const tdDisplay = document.createElement("td");
    tdDisplay.textContent = u.display_name || "";
    tr.appendChild(tdDisplay);

    const tdRole = document.createElement("td");
    if (u.admin) {
      const badge = document.createElement("span");
      badge.className = "admin-badge";
      badge.textContent = "admin";
      tdRole.appendChild(badge);
    } else {
      tdRole.textContent = "user";
    }
    tr.appendChild(tdRole);

    const tdActions = document.createElement("td");
    tdActions.className = "actions";

    // Don't show action buttons for yourself
    if (u.id !== currentUser.id) {
      // Toggle admin button
      const adminBtn = document.createElement("button");
      adminBtn.className = "btn btn-small " + (u.admin ? "btn-cancel" : "btn-primary");
      adminBtn.textContent = u.admin ? "Remove admin" : "Make admin";
      adminBtn.addEventListener("click", () => toggleAdmin(u));
      tdActions.appendChild(adminBtn);

      // Reset password button
      const pwBtn = document.createElement("button");
      pwBtn.className = "btn btn-small btn-primary";
      pwBtn.textContent = "Reset password";
      pwBtn.addEventListener("click", () => resetUserPassword(u));
      tdActions.appendChild(pwBtn);

      // Edit display name button
      const editBtn = document.createElement("button");
      editBtn.className = "btn btn-small btn-primary";
      editBtn.textContent = "Edit name";
      editBtn.addEventListener("click", () => editUserDisplayName(u));
      tdActions.appendChild(editBtn);

      // Delete button
      const delBtn = document.createElement("button");
      delBtn.className = "btn btn-small btn-danger";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", () => deleteUser(u));
      tdActions.appendChild(delBtn);
    } else {
      tdActions.textContent = "(you)";
    }

    tr.appendChild(tdActions);
    tbody.appendChild(tr);
  }
}

// --- Admin: toggle admin status ---
async function toggleAdmin(user) {
  const newAdmin = !user.admin;
  const data = await api(`/users/${user.id}`, {
    method: "PATCH",
    body: { admin: newAdmin },
  });
  if (!data || data.error) {
    alert(data?.error || "Failed to update user.");
    return;
  }
  loadUsers();
}

// --- Admin: reset password ---
async function resetUserPassword(user) {
  const ok = await confirmDialog(
    "Reset password for " + user.username,
    "Enter a new password for this user.",
    `<div class="form-group" style="margin-top:0.5rem;"><label for="reset-pw-input">New password (${MIN_PASSWORD_LENGTH}+ characters)</label><input class="field-input" type="password" id="reset-pw-input" autocomplete="new-password"></div>`
  );
  if (!ok) return;

  const password = document.getElementById("reset-pw-input")?.value || "";
  if (password.length < MIN_PASSWORD_LENGTH) {
    alert(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    return;
  }

  const data = await api(`/users/${user.id}`, {
    method: "PATCH",
    body: { password },
  });
  if (!data || data.error) {
    alert(data?.error || "Failed to reset password.");
    return;
  }
  alert("Password reset successfully.");
}

// --- Admin: edit display name ---
async function editUserDisplayName(user) {
  const ok = await confirmDialog(
    "Edit display name for " + user.username,
    "Enter a new display name.",
    '<div class="form-group" style="margin-top:0.5rem;"><label for="edit-name-input">Display name</label><input class="field-input" type="text" id="edit-name-input" value="' + (user.display_name || "").replace(/"/g, "&quot;") + '" autocomplete="off"></div>'
  );
  if (!ok) return;

  const displayName = document.getElementById("edit-name-input")?.value.trim() || "";
  if (!displayName) {
    alert("Display name cannot be empty.");
    return;
  }

  const data = await api(`/users/${user.id}`, {
    method: "PATCH",
    body: { display_name: displayName },
  });
  if (!data || data.error) {
    alert(data?.error || "Failed to update display name.");
    return;
  }
  loadUsers();
}

// --- Admin: delete user ---
async function deleteUser(user) {
  const ok = await confirmDialog(
    "Delete user " + user.username + "?",
    "This will permanently delete this user and all their lists. This cannot be undone.",
    ""
  );
  if (!ok) return;

  const data = await api(`/users/${user.id}`, { method: "DELETE" });
  if (data && data.error) {
    alert(data.error);
    return;
  }
  loadUsers();
}

// --- Admin: create user ---
document.getElementById("btn-create-user").addEventListener("click", async () => {
  const msgEl = document.getElementById("create-msg");
  hideMsg(msgEl);

  const username = document.getElementById("new-username").value.trim();
  const displayName = document.getElementById("new-display").value.trim();
  const password = document.getElementById("new-password").value;
  const admin = document.getElementById("new-admin").checked;

  if (!username || !password) {
    showMsg(msgEl, "Username and password are required.", false);
    return;
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    showMsg(msgEl, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`, false);
    return;
  }

  const data = await api("/users", {
    method: "POST",
    body: { username, display_name: displayName || username, password, admin },
  });
  if (!data || data.error) {
    showMsg(msgEl, data?.error || "Failed to create user.", false);
    return;
  }

  showMsg(msgEl, "User " + data.username + " created.", true);
  document.getElementById("new-username").value = "";
  document.getElementById("new-display").value = "";
  document.getElementById("new-password").value = "";
  document.getElementById("new-admin").checked = false;
  loadUsers();
});

// --- Contacts ---
async function loadContacts() {
  const data = await api("/contacts");
  if (!data || data.error) return;

  // Incoming requests
  const inSection = document.getElementById("contacts-incoming");
  const inList = document.getElementById("contacts-incoming-list");
  inList.innerHTML = "";
  if (data.incoming.length > 0) {
    inSection.classList.remove("hidden");
    for (const u of data.incoming) {
      const row = document.createElement("div");
      row.className = "contact-item";

      const info = document.createElement("span");
      const name = document.createElement("span");
      name.className = "contact-name";
      name.textContent = u.display_name;
      const uname = document.createElement("span");
      uname.className = "contact-username";
      uname.textContent = " (" + u.username + ")";
      info.appendChild(name);
      info.appendChild(uname);
      row.appendChild(info);

      const actions = document.createElement("span");
      actions.className = "contact-actions";

      const acceptBtn = document.createElement("button");
      acceptBtn.className = "btn btn-primary btn-small";
      acceptBtn.textContent = "Accept";
      acceptBtn.addEventListener("click", async () => {
        await api("/contacts/accept", { method: "POST", body: { user_id: u.id } });
        loadContacts();
      });
      actions.appendChild(acceptBtn);

      const declineBtn = document.createElement("button");
      declineBtn.className = "btn btn-danger btn-small";
      declineBtn.textContent = "Decline";
      declineBtn.addEventListener("click", async () => {
        await api("/contacts/decline", { method: "POST", body: { user_id: u.id } });
        loadContacts();
      });
      actions.appendChild(declineBtn);

      row.appendChild(actions);
      inList.appendChild(row);
    }
  } else {
    inSection.classList.add("hidden");
  }

  // Outgoing requests
  const outSection = document.getElementById("contacts-outgoing");
  const outList = document.getElementById("contacts-outgoing-list");
  outList.innerHTML = "";
  if (data.outgoing.length > 0) {
    outSection.classList.remove("hidden");
    for (const u of data.outgoing) {
      const row = document.createElement("div");
      row.className = "contact-item";

      const info = document.createElement("span");
      const name = document.createElement("span");
      name.className = "contact-name";
      name.textContent = u.display_name;
      const uname = document.createElement("span");
      uname.className = "contact-username";
      uname.textContent = " (" + u.username + ")";
      info.appendChild(name);
      info.appendChild(uname);
      row.appendChild(info);

      const actions = document.createElement("span");
      actions.className = "contact-actions";

      const cancelBtn = document.createElement("button");
      cancelBtn.className = "btn btn-cancel btn-small";
      cancelBtn.textContent = "Cancel";
      cancelBtn.addEventListener("click", async () => {
        await api("/contacts/cancel", { method: "POST", body: { user_id: u.id } });
        loadContacts();
      });
      actions.appendChild(cancelBtn);

      row.appendChild(actions);
      outList.appendChild(row);
    }
  } else {
    outSection.classList.add("hidden");
  }

  // Contacts list
  const contactsList = document.getElementById("contacts-list");
  contactsList.innerHTML = "";
  if (data.contacts.length > 0) {
    for (const u of data.contacts) {
      const row = document.createElement("div");
      row.className = "contact-item";

      const info = document.createElement("span");
      const name = document.createElement("span");
      name.className = "contact-name";
      name.textContent = u.display_name;
      const uname = document.createElement("span");
      uname.className = "contact-username";
      uname.textContent = " (" + u.username + ")";
      info.appendChild(name);
      info.appendChild(uname);
      row.appendChild(info);

      const actions = document.createElement("span");
      actions.className = "contact-actions";

      const removeBtn = document.createElement("button");
      removeBtn.className = "btn btn-danger btn-small";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", async () => {
        const ok = await confirmDialog(
          "Remove contact",
          "Remove " + u.display_name + " from your contacts?",
          ""
        );
        if (!ok) return;
        await api("/contacts/" + u.id, { method: "DELETE" });
        loadContacts();
      });
      actions.appendChild(removeBtn);

      row.appendChild(actions);
      contactsList.appendChild(row);
    }
  } else {
    const empty = document.createElement("div");
    empty.className = "contact-empty";
    empty.textContent = "No contacts yet";
    contactsList.appendChild(empty);
  }
}

// --- Send contact request ---
document.getElementById("btn-send-request").addEventListener("click", async () => {
  const msgEl = document.getElementById("contact-msg");
  hideMsg(msgEl);
  const username = document.getElementById("contact-username").value.trim();
  if (!username) {
    showMsg(msgEl, "Enter a username.", false);
    return;
  }
  const data = await api("/contacts/request", {
    method: "POST",
    body: { username },
  });
  if (!data || data.error) {
    showMsg(msgEl, data?.error || "Failed to send request.", false);
    return;
  }
  if (data.auto_accepted) {
    showMsg(msgEl, "They had already requested you -- contact added!", true);
  } else {
    showMsg(msgEl, "Request sent.", true);
  }
  document.getElementById("contact-username").value = "";
  loadContacts();
});

// --- Init ---
loadCurrentUser();
