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
}

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
