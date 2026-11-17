/* Versioned preparation and video review. All writes use scoped RPCs. */
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
const clone = (value) => JSON.parse(JSON.stringify(value));
const uuid = () => crypto.randomUUID();
const memory = {
  get(key) {
    try {
      return JSON.parse(sessionStorage.getItem(key) || "null");
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* optional */
    }
  },
  remove(key) {
    try {
      sessionStorage.removeItem(key);
    } catch {
      /* optional */
    }
  },
};
const timecode = (value) => {
  const millis = Math.round(Math.max(0, Number(value) || 0) * 1000);
  const seconds = Math.floor(millis / 1000);
  const fraction = String(millis % 1000)
    .padStart(3, "0")
    .replace(/0+$/, "");
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}${fraction ? "." + fraction : ""}`;
};
const answerText = (value) =>
  typeof value === "boolean"
    ? value
      ? "Confirmed"
      : "Not confirmed"
    : String(value || "Not provided");
function failure(error) {
  const text = String(error?.message || error || "");
  if (/changed|superseded|media_changed/i.test(text))
    return "A newer version is available. Your draft is kept here. Reload the current version before saving again.";
  if (/required_answers_missing/i.test(text))
    return "Complete every required question before submitting. Your answers are still here.";
  if (/unresolved_notes/i.test(text))
    return "There are open change notes. Submit the changes, or ask Nelson to resolve them before approving.";
  if (/not_found|42501/i.test(text))
    return "This project or version is no longer available through this link.";
  return "That did not save. Your information is still here. Check your connection and try again.";
}
function message(root, text) {
  let el = root.querySelector(":scope > .ce-error");
  if (!el) {
    el = document.createElement("p");
    el.className = "ce-error";
    el.setAttribute("role", "alert");
    root.prepend(el);
  }
  el.textContent = text;
}
function clearMessage(root) {
  root.querySelector(":scope > .ce-error")?.remove();
}
function progress(prep, answers) {
  const required = prep.questions.filter((q) => q.required);
  return {
    total: required.length,
    done: required.filter((q) =>
      q.type === "check"
        ? answers[q.id] === true
        : String(answers[q.id] || "").trim(),
    ).length,
  };
}
function answerSummary(prep) {
  return `<dl class="ce-answers">${prep.questions.map((q) => `<div><dt>${esc(q.label)}</dt><dd>${esc(answerText(prep.answers?.[q.id]))}</dd></div>`).join("")}</dl>`;
}
const status = (value) => `<span class="ce-status">${esc(value)}</span>`;

export async function mountClientExperience(
  root,
  { rpc, project, toast = () => {}, onChange = () => {}, onDirty = () => {} },
) {
  if (!root) return;
  const dirty = new Set();
  const prepKey = `ce_staff_prep_${project.id}`;
  const videoKey = `ce_staff_video_${project.id}`;
  const feedbackKey = `ce_staff_feedback_${project.id}`;
  let payload = null,
    editor = null,
    busy = false,
    destroyed = false;
  const mark = (key, yes) => {
    yes ? dirty.add(key) : dirty.delete(key);
    onDirty(dirty.size > 0);
  };
  const savedEditor = memory.get(prepKey);
  if (savedEditor) {
    editor = savedEditor;
    mark("prep", true);
  }
  const abort = new AbortController();
  const bind = (type, fn) =>
    root.addEventListener(type, fn, { signal: abort.signal });
  root.innerHTML =
    '<p class="ce-muted" role="status">Loading preparation and review…</p>';

  function questionRows() {
    return editor.questions
      .map(
        (q, index) => `<fieldset class="ce-question" data-question="${index}">
      <legend>Question ${index + 1}</legend>
      <label>Question<input data-q="label" maxlength="240" value="${esc(q.label)}" required></label>
      <div class="ce-inline"><label>Answer type<select data-q="type">${[
        ["short", "Short answer"],
        ["long", "Detailed answer"],
        ["date", "Date"],
        ["choice", "Choose one"],
        ["check", "Confirmation"],
      ]
        .map(
          ([v, l]) =>
            `<option value="${v}"${q.type === v ? " selected" : ""}>${l}</option>`,
        )
        .join("")}</select></label>
      <label class="ce-check"><input type="checkbox" data-q="required"${q.required ? " checked" : ""}>Required</label>
      <button class="ce-link" type="button" data-ce="remove-question" data-index="${index}">Remove</button></div>
      <label data-options${q.type === "choice" ? "" : " hidden"}>Options, one per line<textarea data-q="options" rows="3">${esc((q.options || []).join("\n"))}</textarea></label>
    </fieldset>`,
      )
      .join("");
  }
  function prepEditor() {
    return `<form class="ce-form" data-ce-form="prep" novalidate>
      <h4>${editor.id ? "Edit checklist draft" : "New checklist version"}</h4>
      <p class="ce-muted">Drafts stay private. Publishing makes this version available in the client portal.</p>
      <label>Title<input name="title" maxlength="180" value="${esc(editor.title)}"></label>
      <label>Instructions<textarea name="instructions" maxlength="4000" rows="3">${esc(editor.instructions)}</textarea></label>
      <div class="ce-questions">${questionRows()}</div>
      <button type="button" class="ce-link" data-ce="add-question">Add a question</button>
      <div class="ce-actions"><button class="btn btn-ghost" name="intent" value="save" type="submit">Save draft</button><button class="btn btn-gold" name="intent" value="publish" type="submit">Save and publish</button><button class="ce-link" type="button" data-ce="cancel-prep">Close editor</button></div>
    </form>`;
  }
  function preparationSection() {
    const current = payload.preparations.find((p) => p.current);
    const draft = payload.preparations.find((p) => p.status === "draft");
    return `<section class="ce-section"><header class="ce-heading"><div><h3>Client preparation</h3><p>Service checklist, client answers and readiness.</p></div>${!editor ? `<button class="btn btn-ghost" type="button" data-ce="new-prep">${current ? "Create revised checklist" : "Use service checklist"}</button>` : ""}</header>
      ${editor ? prepEditor() : ""}
      ${draft && !editor ? `<p class="ce-inline">${status("Draft")} ${esc(draft.title)} <button class="ce-link" type="button" data-ce="edit-prep" data-id="${draft.id}">Edit draft</button></p>` : ""}
      ${
        current
          ? `<div class="ce-current"><div class="ce-inline"><h4>${esc(current.title)}</h4>${status(current.status)}<span class="ce-muted">Version ${current.revision}</span></div><p>${current.completed_required} of ${current.total_required} required answers complete</p>${answerSummary(current)}
        ${current.status === "submitted" ? `<form class="ce-form" data-ce-form="prep-review" data-id="${current.id}" data-version="${current.version}"><label>Feedback visible to the client<textarea name="feedback" rows="2" maxlength="4000">${esc(memory.get(feedbackKey)?.version === current.version ? memory.get(feedbackKey).feedback : current.feedback)}</textarea></label><button class="btn btn-gold" type="submit">Mark preparation reviewed</button></form>` : current.feedback ? `<p><strong>Review feedback:</strong> ${esc(current.feedback)}</p>` : ""}</div>`
          : !editor
            ? '<p class="ce-muted">Publish the service checklist when you are ready to collect the client’s production details.</p>'
            : ""
      }
      ${payload.preparations
        .filter((p) => !p.current && p.status !== "draft")
        .map(
          (p) =>
            `<details class="ce-history"><summary>Earlier preparation, version ${p.revision} · ${esc(p.status)}</summary>${answerSummary(p)}</details>`,
        )
        .join("")}
    </section>`;
  }
  function videoSection() {
    const items = payload.video_items || [],
      reviews = payload.reviews || [];
    const restored = memory.get(videoKey) || {};
    const selected =
      items.find((i) => i.id === restored.item_id) ||
      items.find((i) => i.client_scope) ||
      items[0];
    return `<section class="ce-section"><header class="ce-heading"><div><h3>Video review</h3><p>Publish the exact client-visible cut, then review timestamped notes.</p></div><a class="ce-link" href="/admin.html?p=${encodeURIComponent(project.id)}" target="_blank" rel="noopener">Files in Studio ↗</a></header>
      ${
        items.length
          ? `<form class="ce-form ce-video-publish" data-ce-form="video" data-request-id="${esc(restored.request_id || uuid())}">
        <div class="ce-fields"><label>Video file<select name="item_id">${items.map((i) => `<option value="${i.id}"${selected?.id === i.id ? " selected" : ""}${i.client_scope ? "" : " disabled"}>${esc(i.gallery_title || "Video")} · ${esc(i.filename || "Untitled")} ${i.client_scope === "preview" ? "(preview)" : i.client_scope === "clean" ? "(clean)" : "(not available to client)"}</option>`).join("")}</select></label>
        <label>Review title<input name="title" maxlength="180" required value="${esc(restored.title || "")}" placeholder="For example, Brand film, second cut"></label></div>
        <label>Version<select name="supersedes_id"><option value="">Start a new file review</option>${reviews
          .filter((r) => r.current)
          .map(
            (r) =>
              `<option value="${r.id}"${restored.supersedes_id === r.id ? " selected" : ""}>Replace ${esc(r.title)}, version ${r.revision}</option>`,
          )
          .join("")}</select></label>
        <button class="btn btn-gold" type="submit"${items.some((i) => i.client_scope) ? "" : " disabled"}>Publish review version</button><p class="ce-muted">Publishing adds portal controls. It does not notify the client or change media/payment access.</p>
      </form>`
          : '<p class="ce-muted">Upload a video in Studio before publishing a review. Held clean files remain protected.</p>'
      }
      ${reviews
        .map(
          (
            r,
          ) => `<details class="ce-history"${r.current ? " open" : ""}><summary>${esc(r.title)} · version ${r.revision} · ${r.media_scope === "preview" ? "Preview" : "Clean"} · ${esc(r.status)}${r.current ? "" : " · Earlier version, read-only"}</summary>
        ${r.approved_by ? `<p>Approved by ${esc(r.approved_by)}</p>` : ""}
        ${r.notes.length ? `<ol class="ce-notes">${r.notes.map((n) => `<li><div class="ce-inline"><code>${timecode(n.at_seconds)}</code>${n.resolved_at ? status("Resolved") : status("Open")}${r.current && r.status !== "approved" ? `<button type="button" class="ce-link" data-ce="resolve" data-note="${n.id}" data-revision="${n.revision}" data-resolved="${n.resolved_at ? "false" : "true"}">${n.resolved_at ? "Reopen" : "Resolve"}</button>` : ""}</div><p>${esc(n.body)}</p></li>`).join("")}</ol>` : '<p class="ce-muted">No notes on this version.</p>'}
      </details>`,
        )
        .join("")}
    </section>`;
  }
  function render() {
    root.innerHTML = preparationSection() + videoSection();
    if (memory.get(videoKey)) mark("video", true);
    const feedback = root.querySelector('[data-ce-form="prep-review"]');
    if (
      feedback &&
      memory.get(feedbackKey)?.version === feedback.dataset.version
    )
      mark("feedback", true);
  }
  function readEditor(form) {
    editor.title = form.elements.title.value;
    editor.instructions = form.elements.instructions.value;
    editor.questions = [...form.querySelectorAll("[data-question]")].map(
      (el, index) => ({
        id: editor.questions[index].id,
        label: el.querySelector('[data-q="label"]').value,
        type: el.querySelector('[data-q="type"]').value,
        required: el.querySelector('[data-q="required"]').checked,
        ...(el.querySelector('[data-q="type"]').value === "choice"
          ? {
              options: el
                .querySelector('[data-q="options"]')
                .value.split("\n")
                .map((x) => x.trim())
                .filter(Boolean),
            }
          : {}),
      }),
    );
    memory.set(prepKey, editor);
  }
  function readVideo(form) {
    const item = payload.video_items.find(
      (i) => i.id === form.elements.item_id.value,
    );
    const prior = payload.reviews.find(
      (r) => r.id === form.elements.supersedes_id.value,
    );
    return {
      item_id: item?.id,
      gallery_id: item?.gallery_id,
      title: form.elements.title.value,
      supersedes_id: prior?.id || null,
      expected_version: prior?.version || null,
      request_id: form.dataset.requestId,
    };
  }
  async function reload() {
    try {
      const next = await rpc("bk_crm_client_experience", {
        p_project: project.id,
      });
      if (destroyed) return;
      payload = next;
      render();
    } catch (error) {
      message(
        root,
        "Preparation and video review could not load. Existing forms are kept. Try again.",
      );
      if (!root.querySelector('[data-ce="retry"]'))
        root.insertAdjacentHTML(
          "beforeend",
          '<button class="ce-link" type="button" data-ce="retry">Try again</button>',
        );
    }
  }
  bind("input", (event) => {
    const form = event.target.closest("[data-ce-form]");
    if (form?.dataset.ceForm === "prep") {
      readEditor(form);
      mark("prep", true);
    }
    if (form?.dataset.ceForm === "video") {
      memory.set(videoKey, readVideo(form));
      mark("video", true);
    }
    if (form?.dataset.ceForm === "prep-review") {
      memory.set(feedbackKey, {
        version: form.dataset.version,
        feedback: form.elements.feedback.value,
      });
      mark("feedback", true);
    }
  });
  bind("change", (event) => {
    if (event.target.matches('[data-q="type"]')) {
      readEditor(event.target.closest("form"));
      render();
    }
  });
  bind("click", async (event) => {
    const button = event.target.closest("[data-ce]");
    if (!button || busy) return;
    event.stopPropagation();
    const action = button.dataset.ce;
    if (action === "retry") return reload();
    if (action === "new-prep" || action === "edit-prep") {
      const current =
        payload.preparations.find((p) => p.id === button.dataset.id) ||
        payload.preparations.find((p) => p.current);
      editor = {
        ...(action === "edit-prep"
          ? { id: current.id, version: current.version }
          : {}),
        title: current?.title || payload.prep_defaults.title,
        instructions:
          current?.instructions || payload.prep_defaults.instructions,
        questions: clone(current?.questions || payload.prep_defaults.questions),
        request_id: uuid(),
      };
      memory.set(prepKey, editor);
      render();
    } else if (action === "add-question") {
      readEditor(root.querySelector('[data-ce-form="prep"]'));
      editor.questions.push({
        id: "q_" + uuid().replaceAll("-", ""),
        label: "",
        type: "long",
        required: false,
      });
      mark("prep", true);
      memory.set(prepKey, editor);
      render();
    } else if (action === "remove-question") {
      readEditor(root.querySelector('[data-ce-form="prep"]'));
      editor.questions.splice(Number(button.dataset.index), 1);
      mark("prep", true);
      memory.set(prepKey, editor);
      render();
    } else if (action === "cancel-prep") {
      editor = null;
      mark("prep", false);
      render();
    } else if (action === "resolve") {
      busy = true;
      button.disabled = true;
      try {
        await rpc("bk_crm_video_resolve", {
          p_note: button.dataset.note,
          p_note_revision: Number(button.dataset.revision),
          p_resolved: button.dataset.resolved === "true",
        });
        await reload();
        toast("Video note updated");
        onChange();
      } catch (error) {
        message(root, failure(error));
        button.disabled = false;
      } finally {
        busy = false;
      }
    }
  });
  bind("submit", async (event) => {
    const form = event.target.closest("[data-ce-form]");
    if (!form) return;
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;
    busy = true;
    clearMessage(root);
    const controls = [...form.querySelectorAll("button")];
    controls.forEach((b) => (b.disabled = true));
    try {
      if (form.dataset.ceForm === "prep") {
        readEditor(form);
        const saved = await rpc("bk_crm_prep_save", {
          p_project: project.id,
          p_data: {
            title: editor.title,
            instructions: editor.instructions,
            questions: editor.questions,
            request_id: editor.request_id,
          },
          p_prep: editor.id || null,
          p_version: editor.version || null,
        });
        editor.id = saved.id;
        editor.version = saved.version;
        memory.set(prepKey, editor);
        if (event.submitter?.value === "publish")
          await rpc("bk_crm_prep_publish", {
            p_prep: saved.id,
            p_version: saved.version,
          });
        editor = null;
        memory.remove(prepKey);
        mark("prep", false);
        toast(
          event.submitter?.value === "publish"
            ? "Preparation published"
            : "Draft saved",
        );
      } else if (form.dataset.ceForm === "prep-review") {
        await rpc("bk_crm_prep_review", {
          p_prep: form.dataset.id,
          p_version: form.dataset.version,
          p_feedback: form.elements.feedback.value,
        });
        memory.remove(feedbackKey);
        mark("feedback", false);
        toast("Preparation reviewed");
      } else if (form.dataset.ceForm === "video") {
        const draft = readVideo(form);
        memory.set(videoKey, draft);
        await rpc("bk_crm_video_publish", {
          p_project: project.id,
          p_data: draft,
        });
        memory.remove(videoKey);
        mark("video", false);
        toast("Review version published");
      }
      await reload();
      onChange();
    } catch (error) {
      message(root, failure(error));
      controls.forEach((b) => (b.disabled = false));
    } finally {
      busy = false;
    }
  });
  await reload();
  return {
    reload,
    destroy() {
      destroyed = true;
      abort.abort();
    },
  };
}

export async function mountPortalPreparation(root, { rpc, projectId, token }) {
  if (!root) return;
  let prep = null,
    history = [],
    busy = false,
    dirty = false,
    answerRevision = 0;
  const conflictKey = `ce_prep_conflict_${projectId}`;
  const abort = new AbortController();
  const key = () => `ce_prep_${projectId}_${prep.id}_${prep.version}`;
  function readAnswers() {
    const values = {};
    for (const q of prep.questions) {
      const field = root.querySelector(`[data-answer="${CSS.escape(q.id)}"]`);
      values[q.id] =
        q.type === "check" ? Boolean(field?.checked) : field?.value || "";
    }
    return values;
  }
  function fields(answers) {
    const readonly = prep.status !== "published";
    return prep.questions
      .map((q) => {
        const label = `${esc(q.label)}${q.required ? '<span class="ce-required">Required</span>' : ""}`;
        const attrs = `data-answer="${esc(q.id)}"${readonly ? " disabled" : ""}`;
        if (q.type === "check")
          return `<label class="ce-check"><input type="checkbox" ${attrs}${answers[q.id] === true ? " checked" : ""}><span>${label}</span></label>`;
        const input =
          q.type === "long"
            ? `<textarea ${attrs} rows="3" maxlength="4000">${esc(answers[q.id] || "")}</textarea>`
            : q.type === "choice"
              ? `<select ${attrs}><option value="">Choose one</option>${q.options.map((o) => `<option${answers[q.id] === o ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`
              : `<input ${attrs} type="${q.type === "date" ? "date" : "text"}" maxlength="4000" value="${esc(answers[q.id] || "")}">`;
        return `<label>${label}${input}</label>`;
      })
      .join("");
  }
  function render() {
    root.hidden = !prep;
    if (!prep) return;
    const draft = memory.get(key());
    const answers = draft?.answers || prep.answers;
    answerRevision = draft?.answer_revision ?? prep.answer_revision;
    dirty = Boolean(
      draft && JSON.stringify(draft.answers) !== JSON.stringify(prep.answers),
    );
    const p = progress(prep, answers);
    root.innerHTML = `<section class="ce-section"><header class="ce-heading"><div><h2 class="sec-h">${esc(prep.title)}</h2><p>Preparation · version ${prep.revision}</p></div>${status(prep.status)}</header>
      ${prep.instructions ? `<p class="ce-copy">${esc(prep.instructions)}</p>` : ""}
      <p class="ce-progress" aria-live="polite">${p.done} of ${p.total} required questions complete</p>
      <form class="ce-form" data-client-prep novalidate>${fields(answers)}${prep.status === "published" ? '<div class="ce-actions"><button class="btn btn-line" type="submit" name="intent" value="save">Save answers</button><button class="btn btn-gold" type="submit" name="intent" value="submit">Submit preparation</button><button class="ce-link" data-prep-latest type="button">Load latest saved answers</button></div>' : '<p class="ce-muted">Your submitted answers are read-only. Nelson can publish a revised checklist if something changes.</p>'}</form>
      ${dirty ? '<p class="ce-muted">Your unsaved answers from this device are restored.</p>' : ""}
      ${prep.feedback ? `<p class="ce-feedback"><strong>Nelson’s feedback:</strong> ${esc(prep.feedback)}</p>` : ""}
      ${history.map((p) => `<details class="ce-history"><summary>Earlier preparation, version ${p.revision}</summary>${answerSummary(p)}</details>`).join("")}
      ${memory.get(conflictKey) ? `<details class="ce-history"><summary>Your previous unsaved answers from this device</summary>${answerSummary(memory.get(conflictKey))}</details>` : ""}
    </section>`;
  }
  async function reload() {
    try {
      const next = await rpc("bk_portal_preparation", {
        p_project: projectId,
        p_token: token,
      });
      if (dirty && prep && root.querySelector("[data-client-prep]")) return;
      prep = next.current;
      history = next.history || [];
      render();
    } catch (error) {
      root.hidden = false;
      message(
        root,
        "Preparation could not refresh. Any answers you are editing are still here.",
      );
    }
  }
  root.addEventListener(
    "input",
    () => {
      if (!prep || prep.status !== "published") return;
      const answers = readAnswers();
      dirty = true;
      memory.set(key(), { answers, answer_revision: answerRevision });
      const p = progress(prep, answers);
      root.querySelector(".ce-progress").textContent =
        `${p.done} of ${p.total} required questions complete`;
    },
    { signal: abort.signal },
  );
  root.addEventListener(
    "submit",
    async (event) => {
      const form = event.target.closest("[data-client-prep]");
      if (!form) return;
      event.preventDefault();
      event.stopPropagation();
      if (busy) return;
      const answers = readAnswers();
      memory.set(key(), { answers, answer_revision: answerRevision });
      busy = true;
      clearMessage(root);
      form.querySelectorAll("button").forEach((b) => (b.disabled = true));
      try {
        prep = await rpc("bk_portal_prep_save", {
          p_project: projectId,
          p_token: token,
          p_prep: prep.id,
          p_version: prep.version,
          p_answer_revision: answerRevision,
          p_answers: answers,
          p_submit: event.submitter?.value === "submit",
        });
        memory.remove(key());
        memory.remove(conflictKey);
        dirty = false;
        render();
        const saved = document.createElement("p");
        saved.className = "ce-saved";
        saved.setAttribute("role", "status");
        saved.textContent =
          prep.status === "submitted"
            ? "Preparation submitted. Nelson can review your answers."
            : "Answers saved.";
        root.append(saved);
      } catch (error) {
        message(root, failure(error));
        form.querySelectorAll("button").forEach((b) => (b.disabled = false));
      } finally {
        busy = false;
      }
    },
    { signal: abort.signal },
  );
  root.addEventListener(
    "click",
    async (event) => {
      if (!event.target.closest("[data-prep-latest]") || busy || !prep) return;
      event.stopPropagation();
      if (dirty)
        memory.set(conflictKey, {
          questions: prep.questions,
          answers: readAnswers(),
        });
      memory.remove(key());
      dirty = false;
      await reload();
    },
    { signal: abort.signal },
  );
  await reload();
  return {
    reload,
    destroy() {
      abort.abort();
    },
  };
}

export async function mountPortalVideoReviews(root, { rpc, projectId, token }) {
  if (!root) return;
  let rows = [],
    pending = null,
    destroyed = false;
  const abort = new AbortController();
  const draftKey = (review) =>
    `ce_video_${projectId}_${review.id}_${review.version}`;
  const decisionKey = (review) =>
    `ce_video_decision_${projectId}_${review.id}_${review.version}`;
  const reviewFor = (el) =>
    rows.find((r) => r.id === el.closest("[data-review-id]")?.dataset.reviewId);
  function parseTime(value) {
    const text = String(value).trim();
    const parts = text.split(":");
    const seconds =
      parts.length === 2
        ? Number(parts[0]) * 60 + Number(parts[1])
        : Number(text);
    if (
      !Number.isFinite(seconds) ||
      seconds < 0 ||
      seconds > 21600 ||
      parts.length > 2
    )
      throw Error("Enter a timestamp between 0:00 and 360:00.");
    return seconds;
  }
  function noteRows(review, editable) {
    return review.notes.length
      ? `<ol class="ce-notes">${review.notes.map((n) => `<li><div class="ce-video-note-actions"><button class="ce-time" type="button" data-video-action="seek" data-seconds="${Number(n.at_seconds)}">${timecode(n.at_seconds)}</button><span>${n.resolved_at ? "Resolved" : "Change requested"}${editable ? ` · <button class="ce-link" type="button" data-video-action="edit" data-note="${n.id}">Edit note</button>` : ""}</span></div><p>${esc(n.body)}</p></li>`).join("")}</ol>`
      : '<p class="ce-muted">No notes on this version.</p>';
  }
  function renderCard(card) {
    const candidates = rows.filter(
      (r) =>
        r.item_id === card.dataset.itemId &&
        r.gallery_id === card.dataset.galleryId &&
        r.media_scope === card.dataset.mediaScope,
    );
    const matching = candidates.filter(
      (r) =>
        r.media_revision === card.dataset.mediaRevision &&
        r.asset_key &&
        r.asset_key === card.dataset.assetKey,
    );
    let box = card.querySelector(":scope > .ce-video-review");
    if (!matching.length || !card.querySelector("video")) {
      box?.remove();
      let notice = card.querySelector(":scope > .ce-player-version");
      if (candidates.length && card.querySelector("video")) {
        if (!notice) {
          notice = document.createElement("p");
          notice.className = "ce-muted ce-player-version";
          card.append(notice);
        }
        notice.textContent =
          "A different video version is available. Reload the page to review the current cut. Any unsaved notes are kept on this device.";
      } else notice?.remove();
      return;
    }
    card.querySelector(":scope > .ce-player-version")?.remove();
    if (
      box?.querySelector('[data-dirty="true"]') ||
      box?.dataset.busy === "true"
    )
      return;
    if (!box) {
      box = document.createElement("section");
      box.className = "ce-video-review";
      card.append(box);
    }
    const current = matching.find((r) => r.current) || null;
    const readonly = !current || current.status !== "published";
    const review = current || matching.at(-1);
    const draft = memory.get(draftKey(review)) || {
      body: "",
      at: "0:00",
      request_id: uuid(),
    };
    const signature = memory.get(decisionKey(review))?.signer || "";
    const openNotes = review.notes.filter((n) => !n.resolved_at).length;
    box.dataset.reviewId = review.id;
    box.dataset.notesRevision = review.notes_revision;
    box.id = `review-${review.id}`;
    box.innerHTML = `<header class="ce-heading"><div><h3>${esc(review.title)}</h3><p>Review version ${review.revision} · ${review.media_scope === "preview" ? "Watermarked preview" : "Clean file"}</p></div>${status(review.current ? review.status : "Earlier version")}</header>
      ${noteRows(review, !readonly)}
      ${
        readonly
          ? `<p data-video-status>${review.status === "approved" ? `Approved${review.approved_by ? ` by ${esc(review.approved_by)}` : ""}.` : review.status === "changes" ? "Your changes are submitted for this version." : "This earlier version is read-only."}</p>`
          : `
        <form class="ce-form ce-note-compose" data-video-note data-request-id="${esc(draft.request_id)}" data-note-id="${esc(draft.note_id || "")}" data-note-revision="${draft.note_revision || ""}">
          <div class="ce-inline"><label>Timestamp<input name="at" inputmode="decimal" value="${esc(draft.at)}" aria-label="Timestamp, minutes and seconds" placeholder="0:12"></label><button class="ce-link" type="button" data-video-action="capture">Use current playhead</button></div>
          <label>What should change here?<textarea name="body" rows="3" maxlength="2000" required>${esc(draft.body)}</textarea></label>
          <div class="ce-actions"><button class="btn btn-line" type="submit">${draft.note_id ? "Save edited note" : "Save timestamp note"}</button>${draft.note_id ? '<button class="ce-link" type="button" data-video-action="cancel-edit">Cancel edit</button>' : ""}</div>
        </form>
        <form class="ce-form ce-review-decision" data-video-decision data-decision="${openNotes ? "changes" : "approved"}">
          ${!openNotes ? `<label>Your name<input name="signer" maxlength="120" value="${esc(signature)}" required autocomplete="name"></label>` : ""}
          <label class="ce-check"><input name="confirm" type="checkbox" required><span>${openNotes ? `These ${openNotes} change note${openNotes === 1 ? " is" : "s are"} ready for Nelson to review.` : "I have reviewed this exact video version and approve it."}</span></label>
          <button class="btn btn-gold" type="submit">${openNotes ? `Submit ${openNotes} change${openNotes === 1 ? "" : "s"}` : "Approve this version"}</button>
        </form>`
      }
      ${matching
        .filter((r) => r.id !== review.id)
        .map(
          (r) =>
            `<details class="ce-history"><summary>Earlier version ${r.revision} · ${esc(r.status)}</summary>${noteRows(r, false)}</details>`,
        )
        .join("")}`;
    if (draft.body && !readonly)
      box.querySelector("[data-video-note]").dataset.dirty = "true";
  }
  async function reload() {
    if (pending) return pending;
    if (!root.querySelector(".g-video[data-item-id] video")) return;
    pending = (async () => {
      try {
        const data = await rpc("bk_portal_video_reviews", {
          p_project: projectId,
          p_token: token,
        });
        if (destroyed) return;
        rows = data.rows || [];
        root.querySelector(".ce-review-load-error")?.remove();
        root.querySelectorAll(".g-video[data-item-id]").forEach(renderCard);
        if (location.hash.startsWith("#review-"))
          root
            .querySelector(`#${CSS.escape(location.hash.slice(1))}`)
            ?.scrollIntoView({ block: "center" });
      } catch (error) {
        if (!root.querySelector(".ce-review-load-error"))
          root.insertAdjacentHTML(
            "beforeend",
            '<p class="ce-error ce-review-load-error" role="alert">Video review could not refresh. Your video and any unsaved notes stay available.</p>',
          );
      } finally {
        pending = null;
      }
    })();
    return pending;
  }
  root.addEventListener(
    "input",
    (event) => {
      const review = reviewFor(event.target),
        form = event.target.closest("form");
      if (!review || !form) return;
      form.dataset.dirty = "true";
      if (form.matches("[data-video-note]"))
        memory.set(draftKey(review), {
          body: form.elements.body.value,
          at: form.elements.at.value,
          request_id: form.dataset.requestId,
          note_id: form.dataset.noteId || null,
          note_revision: Number(form.dataset.noteRevision) || null,
        });
      if (form.matches("[data-video-decision]"))
        memory.set(decisionKey(review), {
          signer: form.elements.signer?.value || "",
        });
    },
    { signal: abort.signal },
  );
  root.addEventListener(
    "click",
    (event) => {
      const button = event.target.closest("[data-video-action]");
      if (!button) return;
      event.stopPropagation();
      const review = reviewFor(button),
        box = button.closest(".ce-video-review"),
        card = button.closest(".g-video"),
        player = card.querySelector("video");
      if (!review || !player || box.dataset.busy === "true") return;
      if (button.dataset.videoAction === "seek") {
        const target = Number(button.dataset.seconds);
        const seek = () => {
          player.currentTime = Number.isFinite(player.duration)
            ? Math.min(target, player.duration)
            : target;
        };
        try {
          seek();
        } catch {
          player.addEventListener("loadedmetadata", seek, { once: true });
        }
        return;
      }
      const form = box.querySelector("[data-video-note]");
      if (!form) return;
      if (button.dataset.videoAction === "capture") {
        form.elements.at.value = timecode(player.currentTime);
        form.elements.at.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (button.dataset.videoAction === "edit") {
        const note = review.notes.find((n) => n.id === button.dataset.note);
        memory.set(draftKey(review), {
          body: note.body,
          at: timecode(note.at_seconds),
          request_id: uuid(),
          note_id: note.id,
          note_revision: note.revision,
        });
        box
          .querySelectorAll("[data-dirty]")
          .forEach((el) => delete el.dataset.dirty);
        renderCard(card);
        card.querySelector("[data-video-note] textarea")?.focus();
      } else if (button.dataset.videoAction === "cancel-edit") {
        memory.remove(draftKey(review));
        box
          .querySelectorAll("[data-dirty]")
          .forEach((el) => delete el.dataset.dirty);
        renderCard(card);
      }
    },
    { signal: abort.signal },
  );
  root.addEventListener(
    "submit",
    async (event) => {
      const form = event.target.closest(
        "[data-video-note],[data-video-decision]",
      );
      if (!form) return;
      event.preventDefault();
      event.stopPropagation();
      const review = reviewFor(form),
        box = form.closest(".ce-video-review");
      if (!review || box.dataset.busy === "true") return;
      if (form.matches("[data-video-decision]") && !form.reportValidity())
        return;
      box.dataset.busy = "true";
      clearMessage(box);
      const buttons = [...box.querySelectorAll("button")];
      buttons.forEach((b) => (b.disabled = true));
      try {
        if (form.matches("[data-video-note]")) {
          const draft = {
            body: form.elements.body.value,
            at: form.elements.at.value,
            request_id: form.dataset.requestId,
            note_id: form.dataset.noteId || null,
            note_revision: Number(form.dataset.noteRevision) || null,
          };
          memory.set(draftKey(review), draft);
          if (!draft.body.trim()) throw Error("Add a note first");
          await rpc("bk_portal_video_note", {
            p_project: projectId,
            p_token: token,
            p_review: review.id,
            p_version: review.version,
            p_request_id: draft.request_id,
            p_at_seconds: parseTime(draft.at),
            p_body: draft.body,
            p_note: draft.note_id,
            p_note_revision: draft.note_revision,
          });
          memory.remove(draftKey(review));
        } else {
          if (
            box.querySelector("[data-video-note]")?.dataset.dirty === "true" &&
            box.querySelector("[data-video-note] textarea")?.value.trim()
          )
            throw Error(
              "Save your timestamp note before submitting the review.",
            );
          await rpc("bk_portal_video_decide", {
            p_project: projectId,
            p_token: token,
            p_review: review.id,
            p_version: review.version,
            p_notes_revision: Number(box.dataset.notesRevision),
            p_decision: form.dataset.decision,
            p_signer: form.elements.signer?.value || "",
          });
          memory.remove(decisionKey(review));
        }
        delete box.dataset.busy;
        box
          .querySelectorAll("[data-dirty]")
          .forEach((el) => delete el.dataset.dirty);
        await reload();
      } catch (error) {
        message(
          box,
          /timestamp|Save your timestamp|Add a note/i.test(error.message)
            ? error.message
            : failure(error),
        );
        buttons.forEach((b) => (b.disabled = false));
      } finally {
        delete box.dataset.busy;
      }
    },
    { signal: abort.signal },
  );
  const observer = new MutationObserver((records) => {
    if (
      records.some((r) =>
        [...r.addedNodes].some(
          (n) =>
            n.nodeType === 1 &&
            (n.matches?.(".g-video") || n.querySelector?.(".g-video")),
        ),
      )
    )
      reload();
  });
  observer.observe(root, { childList: true, subtree: true });
  await reload();
  return {
    reload,
    destroy() {
      destroyed = true;
      abort.abort();
      observer.disconnect();
    },
  };
}
