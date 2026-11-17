import {
  esc,
  localInput,
  options,
  SERVICES,
} from "./crm-workspace-view.js?v=1";
import { completeSubmission, submissionFor } from "./intake-request.js?v=1";

const sharedKey = "crm-shared-capture";
let pendingShared = "";
const archivedDrafts = new Map();
const channels = {
  Instagram: "Instagram",
  Text: "Text",
  Phone: "Phone",
  Email: "Email",
  Referral: "Referral",
  Website: "Website",
  Other: "Other",
};

export function contactFromMessage(message) {
  const email =
    message.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/i)
      ?.[0] || "";
  const instagram =
    message.match(/(?:^|\s)@([A-Za-z0-9._]{1,30})(?=\s|$|[,!?])/m)?.[1] || "";
  const phone = (message.match(/\+?\d[\d(). -]{6,}\d/g) || []).find((value) => {
    const digits = value.replace(/\D/g, "");
    return digits.length >= 10 && digits.length <= 15;
  }) || "";
  return { client_email: email, instagram, client_phone: phone };
}

// Remove shared messages from the address bar before sign-in or navigation.
export function receiveSharedCapture(
  location = window.location,
  history = window.history,
  storage,
) {
  const url = new URL(location.href);
  const parts = ["share_title", "share_text", "share_url"].map((key) =>
    url.searchParams.get(key)
  ).filter(Boolean);
  if (parts.length) {
    pendingShared = parts.join("\n").slice(0, 4000);
    try {
      if (storage === undefined) storage = window.sessionStorage;
      storage?.setItem(sharedKey, pendingShared);
    } catch (_) { /* in-memory capture still works */ }
    for (const key of ["share_title", "share_text", "share_url"]) {
      url.searchParams.delete(key);
    }
    url.searchParams.set("capture", "1");
    history.replaceState({}, "", url.pathname + url.search);
  }
  return url.searchParams.get("capture") === "1";
}

export function mountQuickCapture(
  root,
  context,
) {
  const { rpc, toast, userId, onCreated, onDirty, sharedMode } = context;
  const draftKey = `crm-capture-draft:${userId}`;
  const archiveKey = draftKey + ":previous";
  let draft = {};
  try {
    draft = JSON.parse(sessionStorage.getItem(draftKey) || "{}");
  } catch (_) { /* storage is optional */ }
  if (context.draftOverride) draft = context.draftOverride;
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) draft = {};
  let shared = pendingShared;
  try {
    shared ||= sessionStorage.getItem(sharedKey);
  } catch (_) { /* use the in-memory share */ }
  const hasDraft = Boolean(
    draft.client_name || draft.details || draft.client_email ||
      draft.client_phone || draft.instagram,
  );
  if (shared && hasDraft && !sharedMode) {
    onDirty?.(true);
    root.innerHTML =
      `<section class="section quick-capture"><h2>A lead draft is open</h2><p>Your saved draft is for ${
        esc(draft.client_name || "an unfinished lead")
      }. A new conversation has also been shared here.</p><p class="muted">${
        esc(shared)
      }</p><div class="actions"><button class="btn" data-capture-existing>Continue saved draft</button><button class="btn primary" data-capture-incoming>Start separate lead</button></div></section>`;
    root.querySelector("[data-capture-existing]").onclick = () =>
      mountQuickCapture(root, { ...context, sharedMode: "saved" });
    root.querySelector("[data-capture-incoming]").onclick = () =>
      mountQuickCapture(root, { ...context, sharedMode: "incoming" });
    return;
  }
  if (sharedMode === "saved") shared = "";
  if (shared && hasDraft) {
    archivedDrafts.set(userId, draft);
    try {
      sessionStorage.setItem(archiveKey, JSON.stringify(draft));
    } catch (_) { /* in-memory recovery remains available */ }
    draft = {};
  }
  if (shared) {
    draft.details = shared;
    Object.assign(draft, contactFromMessage(shared));
  }
  const due = new Date(Date.now() + 24 * 60 * 60 * 1000);
  due.setMinutes(0, 0, 0);
  let previous = archivedDrafts.get(userId);
  try {
    previous ||= JSON.parse(sessionStorage.getItem(archiveKey) || "null");
  } catch (_) { /* optional */ }
  root.innerHTML =
    `<section class="section quick-capture"><div class="section-title"><h2>Capture a lead</h2><button class="btn small" type="button" data-capture-close>Close</button></div>
    <form class="form-grid" id="quickCaptureForm">
      <label class="full">Message or conversation notes<textarea name="details" rows="4" maxlength="4000" placeholder="Paste their message or jot down what they need">${
      esc(draft.details || "")
    }</textarea></label>
      <div class="full actions"><button class="btn small" type="button" data-capture-paste>Paste message</button><button class="btn small" type="button" data-capture-extract>Find contact details</button><span class="field-note" data-capture-hint>Check the contact details before saving.</span></div>
      <label>Name<input name="client_name" autocomplete="name" maxlength="120" required value="${
      esc(draft.client_name || "")
    }"></label>
      <label>Source<select name="referral_source">${
      options(channels, draft.referral_source || "Instagram")
    }</select></label>
      <label>Email<input name="client_email" type="email" autocomplete="email" maxlength="200" value="${
      esc(draft.client_email || "")
    }"></label>
      <label>Phone<input name="client_phone" type="tel" autocomplete="tel" maxlength="40" value="${
      esc(draft.client_phone || "")
    }"></label>
      <label>Instagram<input name="instagram" maxlength="31" pattern="@?[A-Za-z0-9._]{1,30}" placeholder="@handle" value="${
      esc(draft.instagram || "")
    }"></label>
      <label>Service<select name="service">${
      options(SERVICES, draft.service || "other")
    }</select></label>
      <label class="full">Next action<input name="next_action" maxlength="180" required value="${
      esc(draft.next_action || "Reply about the project")
    }"></label>
      <label>Follow up<input name="next_due_at" type="datetime-local" required value="${
      esc(draft.next_due_at || localInput(due.toISOString()))
    }"></label>
      <div class="full actions"><button class="btn primary" type="submit">Save lead & next action</button><span role="status" data-capture-status></span></div>
      <p class="full form-error" role="alert"></p>
    </form>
    ${
      previous
        ? '<button class="btn small" type="button" data-capture-restore>Switch to earlier lead draft</button>'
        : ""
    }
    <details class="capture-install"><summary>Keep this on your phone</summary><p>Open this CRM in Safari, tap Share, then Add to Home Screen. Use Capture to save a conversation while you are away from your desk. Browsers that support sharing to installed apps can also send text here.</p></details></section>`;
  const form = root.querySelector("form");
  let pendingRequest = draft._request || null;
  const restore = root.querySelector("[data-capture-restore]");
  if (restore) {
    restore.onclick = () => {
      const current = {
        ...Object.fromEntries(new FormData(form)),
        _request: pendingRequest,
      };
      archivedDrafts.set(userId, current);
      try {
        sessionStorage.setItem(draftKey, JSON.stringify(previous));
        sessionStorage.setItem(archiveKey, JSON.stringify(current));
      } catch (_) { /* recovery also works in this open tab */ }
      mountQuickCapture(root, {
        ...context,
        sharedMode: "saved",
        draftOverride: previous,
      });
    };
  }
  const hint = root.querySelector("[data-capture-hint]");
  function remember() {
    onDirty?.(true);
    try {
      sessionStorage.setItem(
        draftKey,
        JSON.stringify({
          ...Object.fromEntries(new FormData(form)),
          _request: pendingRequest,
        }),
      );
    } catch (_) { /* optional */ }
  }
  if (Object.keys(draft).length) remember();
  if (shared) {
    pendingShared = "";
    try {
      sessionStorage.removeItem(sharedKey);
    } catch (_) { /* optional */ }
  }
  function extract() {
    const contact = contactFromMessage(form.elements.details.value);
    for (const [key, value] of Object.entries(contact)) {
      if (value && !form.elements[key].value) form.elements[key].value = value;
    }
    hint.textContent = Object.values(contact).some(Boolean)
      ? "Contact details found. Check them before saving."
      : "Add an email, phone number or Instagram handle below.";
    remember();
  }
  root.querySelector("[data-capture-extract]").onclick = extract;
  root.querySelector("[data-capture-paste]").onclick = async () => {
    try {
      form.elements.details.value = (await navigator.clipboard.readText())
        .slice(0, 4000);
      extract();
    } catch (_) {
      hint.textContent =
        "Press and hold in the message box, then choose Paste.";
      form.elements.details.focus();
    }
  };
  form.addEventListener("input", remember);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const button = form.querySelector("[type=submit]");
    const error = form.querySelector(".form-error");
    const payload = Object.fromEntries(new FormData(form));
    payload.instagram = payload.instagram.trim().replace(/^@/, "");
    for (const key of ["client_name", "client_email", "client_phone"]) {
      payload[key] = payload[key].trim();
    }
    error.textContent = "";
    if (!payload.client_email && !payload.client_phone && !payload.instagram) {
      error.textContent = "Add an email, phone number or Instagram handle.";
      return;
    }
    payload.next_due_at = new Date(payload.next_due_at).toISOString();
    button.disabled = true;
    try {
      const fingerprint = JSON.stringify(payload);
      if (pendingRequest?.fingerprint !== fingerprint) {
        pendingRequest = {
          fingerprint,
          id: await submissionFor("quick-capture", payload),
        };
      }
      payload.request_id = pendingRequest.id;
      remember();
      const project = await rpc("bk_crm_capture_lead", { p_data: payload });
      completeSubmission("quick-capture");
      try {
        sessionStorage.removeItem(draftKey);
      } catch (_) { /* optional */ }
      onDirty?.(false);
      toast("Lead and follow-up saved");
      await onCreated(project.id);
    } catch (failure) {
      error.textContent = failure.message ||
        "Could not save. Your message is still here. Try again.";
    } finally {
      button.disabled = false;
    }
  });
}
