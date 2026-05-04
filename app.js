/* Back on Track — single-file app logic (no build step). */

const STORAGE_KEY = "bot:v1";
const DEFAULT_STATE = {
  profile: { name: "", branch: "" },
  syllabus: { rawText: "", subjects: [] },
  roadmap: { targetDate: "", dailyCount: 3, checkpoints: [] },
  tasks: { byDate: {} }, // yyyy-mm-dd -> taskIds[]
  progress: { doneCheckpointIds: {} }, // id -> true
  streak: { current: 0, best: 0, lastDoneDay: "" }, // lastDoneDay: yyyy-mm-dd when "Mark day done"
  reminders: { time: "20:30", notificationsEnabled: false, lastNotifiedDay: "" },
  // Doubt solver is fully offline; keep for backward-compat with older saved state.
  ai: { baseUrl: "", model: "", apiKey: "" },
};

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function safeParse(json, fallback) {
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function addDaysISO(iso, days) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function daysBetweenISO(a, b) {
  const da = new Date(`${a}T00:00:00`);
  const db = new Date(`${b}T00:00:00`);
  const ms = db.getTime() - da.getTime();
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

function normalizeText(s) {
  return (s ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function toast(msg, type = "info") {
  const el = $("#banner");
  if (!el) return;
  el.hidden = false;
  el.textContent = msg;
  el.dataset.type = type;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.hidden = true;
    el.textContent = "";
  }, 3500);
}

function $(sel, root = document) {
  return root.querySelector(sel);
}
function $all(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return deepClone(DEFAULT_STATE);

  const parsed = safeParse(raw, null);
  if (!parsed || typeof parsed !== "object") return deepClone(DEFAULT_STATE);

  // Shallow merge with defaults so future fields exist.
  const next = deepClone(DEFAULT_STATE);
  for (const k of Object.keys(next)) {
    if (parsed[k] && typeof parsed[k] === "object") next[k] = { ...next[k], ...parsed[k] };
    else if (parsed[k] !== undefined) next[k] = parsed[k];
  }

  // Nested merges
  next.profile = { ...DEFAULT_STATE.profile, ...(parsed.profile || {}) };
  next.syllabus = { ...DEFAULT_STATE.syllabus, ...(parsed.syllabus || {}) };
  next.roadmap = { ...DEFAULT_STATE.roadmap, ...(parsed.roadmap || {}) };
  next.tasks = { ...DEFAULT_STATE.tasks, ...(parsed.tasks || {}) };
  next.progress = { ...DEFAULT_STATE.progress, ...(parsed.progress || {}) };
  next.streak = { ...DEFAULT_STATE.streak, ...(parsed.streak || {}) };
  next.reminders = { ...DEFAULT_STATE.reminders, ...(parsed.reminders || {}) };
  next.ai = { ...DEFAULT_STATE.ai, ...(parsed.ai || {}) };

  // Hardening
  if (!Array.isArray(next.syllabus.subjects)) next.syllabus.subjects = [];
  if (!Array.isArray(next.roadmap.checkpoints)) next.roadmap.checkpoints = [];
  if (!next.tasks.byDate || typeof next.tasks.byDate !== "object") next.tasks.byDate = {};
  if (!next.progress.doneCheckpointIds || typeof next.progress.doneCheckpointIds !== "object") next.progress.doneCheckpointIds = {};

  if (typeof next.roadmap.dailyCount !== "number" || !Number.isFinite(next.roadmap.dailyCount)) next.roadmap.dailyCount = 3;
  next.roadmap.dailyCount = clampInt(next.roadmap.dailyCount, 1, 10);

  return next;
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function clampInt(n, min, max) {
  const x = Math.trunc(Number(n));
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

let state = loadState();

/* --------------------------- Navigation / Tabs --------------------------- */

function setView(viewId) {
  const views = $all(".view");
  for (const v of views) v.hidden = v.dataset.view !== viewId;

  for (const tab of $all(".tab")) {
    const selected = tab.dataset.tab === viewId;
    tab.setAttribute("aria-selected", selected ? "true" : "false");
  }

  for (const nb of $all(".navbtn")) {
    const active = nb.dataset.nav === viewId;
    if (active) nb.setAttribute("aria-current", "page");
    else nb.removeAttribute("aria-current");
  }

  // Maintain hash routing for refresh.
  const targetHash = `#${viewId}`;
  if (location.hash !== targetHash) history.replaceState(null, "", targetHash);
}

function initNav() {
  for (const tab of $all(".tab")) {
    tab.addEventListener("click", () => setView(tab.dataset.tab));
  }
  for (const btn of $all("[data-nav]")) {
    btn.addEventListener("click", () => setView(btn.dataset.nav));
  }

  const viewFromHash = (location.hash || "").replace("#", "").trim();
  const allowed = new Set(["today", "syllabus", "roadmap", "doubts", "settings"]);
  setView(allowed.has(viewFromHash) ? viewFromHash : "today");
}

/* --------------------------- Syllabus parsing ---------------------------- */

function parseSyllabusText(raw) {
  const text = normalizeText(raw);
  if (!text) return [];

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const subjects = [];

  let current = null;
  let currentUnit = null;

  const subjectHeader = (line) => {
    const m1 = line.match(/^(subject|paper|course)\s*[:\-–]\s*(.+)$/i);
    if (m1) return m1[2].trim();
    const m2 = line.match(/^([A-Z][A-Z0-9 &()./+]{2,})$/); // ALLCAPS-ish line
    if (m2 && line.length <= 60) return line.trim();
    const m3 = line.match(/^(.+)\s*-\s*syllabus$/i);
    if (m3) return m3[1].trim();
    return "";
  };

  const unitHeader = (line) => {
    // Supports:
    // - Unit 1: Limits and Continuity
    // - UNIT 2 - Integrals
    // - Module 3  Fourier Series
    // - Chapter IV: Laplace
    const m = line.match(/^(unit|module|chapter)\s*([0-9ivx]+)\s*[:\-–—]?\s*(.*)$/i);
    if (!m) return null;
    const kind = String(m[1] || "Unit").trim();
    const num = String(m[2] || "").trim().toUpperCase();
    const rest = String(m[3] || "").trim();
    const prettyKind = kind.charAt(0).toUpperCase() + kind.slice(1).toLowerCase();
    return { title: rest ? `${prettyKind} ${num}: ${rest}` : `${prettyKind} ${num}` };
  };

  const bullet = (line) => {
    const cleaned = line.replace(/^[•\-\*\u2022]+\s*/, "").trim();
    if (!cleaned) return "";
    return cleaned;
  };

  for (const line of lines) {
    const sName = subjectHeader(line);
    if (sName) {
      current = { id: uid("subj"), name: sName, units: [] };
      subjects.push(current);
      currentUnit = null;
      continue;
    }

    const u = unitHeader(line);
    if (u) {
      // If the syllabus doesn't have an explicit SUBJECT header, still treat Unit/Module/Chapter
      // as a real section (instead of being added as a topic under "Topics").
      if (!current) {
        current = { id: uid("subj"), name: "General", units: [] };
        subjects.push(current);
      }
      currentUnit = { id: uid("unit"), title: u.title, topics: [] };
      current.units.push(currentUnit);
      continue;
    }

    const isBullet = /^[•\-\*\u2022]/.test(line);
    const item = isBullet ? bullet(line) : line;

    if (!current) {
      // If no explicit subject yet, create one.
      current = { id: uid("subj"), name: "General", units: [] };
      subjects.push(current);
    }

    if (!currentUnit) {
      currentUnit = { id: uid("unit"), title: "Topics", topics: [] };
      current.units.push(currentUnit);
    }

    // Split by commas/semicolons only if it looks like a list.
    const parts = item.includes(",") ? item.split(",") : [item];
    for (const p of parts) {
      const t = p.trim();
      if (!t) continue;
      currentUnit.topics.push(t);
    }
  }

  // De-dup / cleanup
  for (const s of subjects) {
    s.name = s.name.trim();
    s.units = (s.units || []).map((u) => ({
      ...u,
      title: (u.title || "Unit").trim(),
      topics: (u.topics || []).map((t) => t.trim()).filter(Boolean),
    }));
  }

  return subjects.filter((s) => s.name);
}

function addSubjectManually() {
  const name = prompt("Subject name?");
  if (!name) return;
  const subj = { id: uid("subj"), name: name.trim(), units: [{ id: uid("unit"), title: "Topics", topics: [] }] };
  state.syllabus.subjects.push(subj);
  saveState();
  renderAll();
  toast("Subject added.");
}

function addUnit(subjId) {
  const subj = state.syllabus.subjects.find((s) => s.id === subjId);
  if (!subj) return;
  const title = prompt("Unit / Module title?");
  if (!title) return;
  subj.units.push({ id: uid("unit"), title: title.trim(), topics: [] });
  saveState();
  renderAll();
}

function addTopic(subjId, unitId) {
  const subj = state.syllabus.subjects.find((s) => s.id === subjId);
  const unit = subj?.units?.find((u) => u.id === unitId);
  if (!unit) return;
  const topic = prompt("Topic?");
  if (!topic) return;
  unit.topics.push(topic.trim());
  saveState();
  renderAll();
}

function renameSubject(subjId) {
  const subj = state.syllabus.subjects.find((s) => s.id === subjId);
  if (!subj) return;
  const name = prompt("Rename subject:", subj.name);
  if (!name) return;
  subj.name = name.trim();
  saveState();
  renderAll();
}

function deleteSubject(subjId) {
  if (!confirm("Delete this subject?")) return;
  state.syllabus.subjects = state.syllabus.subjects.filter((s) => s.id !== subjId);
  saveState();
  renderAll();
}

function deleteUnit(subjId, unitId) {
  const subj = state.syllabus.subjects.find((s) => s.id === subjId);
  if (!subj) return;
  if (!confirm("Delete this unit/module?")) return;
  subj.units = (subj.units || []).filter((u) => u.id !== unitId);
  saveState();
  renderAll();
}

function deleteTopic(subjId, unitId, idx) {
  const subj = state.syllabus.subjects.find((s) => s.id === subjId);
  const unit = subj?.units?.find((u) => u.id === unitId);
  if (!unit) return;
  unit.topics.splice(idx, 1);
  saveState();
  renderAll();
}

/* --------------------------- Roadmap generation -------------------------- */

function flattenUnits() {
  const items = [];
  for (const subj of state.syllabus.subjects) {
    for (const unit of subj.units || []) {
      const unitTitle = (unit.title || "").trim();
      if (!unitTitle) continue;
      items.push({
        subject: subj.name,
        unit: unitTitle,
        topicCount: (unit.topics || []).filter(Boolean).length,
      });
    }
  }
  return items;
}

function generateCheckpoints() {
  const items = flattenUnits();
  if (!items.length) {
    toast("Add syllabus subjects/topics first.", "warn");
    return;
  }

  // Shuffle slightly but keep subjects grouped for focus.
  const bySubject = new Map();
  for (const it of items) {
    if (!bySubject.has(it.subject)) bySubject.set(it.subject, []);
    bySubject.get(it.subject).push(it);
  }

  const subjects = Array.from(bySubject.keys()).sort((a, b) => a.localeCompare(b));
  const ordered = [];
  // Interleave subjects so you don’t get stuck in one for too long.
  const buckets = subjects.map((s) => bySubject.get(s));
  let remaining = true;
  while (remaining) {
    remaining = false;
    for (const b of buckets) {
      const it = b.shift();
      if (it) {
        ordered.push(it);
        remaining = true;
      }
    }
  }

  state.roadmap.checkpoints = ordered.map((it, i) => ({
    id: uid("cp"),
    order: i + 1,
    subject: it.subject,
    title: it.unit, // one checkpoint per Unit/Module/Chapter section
    unit: it.unit,
    estimateMin: Math.max(25, Math.min(90, 25 + (it.topicCount || 0) * 6)),
  }));

  // Keep dailyCount and targetDate in state as already set by UI.
  saveState();

  // Rebuild today tasks after regeneration.
  buildTodayTasks(true);
  renderAll();
  toast("Roadmap generated.");
}

function resetProgress() {
  if (!confirm("Reset checkpoint progress and daily tasks?")) return;
  state.progress.doneCheckpointIds = {};
  state.tasks.byDate = {};
  state.streak = { current: 0, best: 0, lastDoneDay: "" };
  saveState();
  renderAll();
  toast("Progress reset.");
}

/* --------------------------- Daily tasks + streak ------------------------ */

function isCheckpointDone(id) {
  return !!state.progress.doneCheckpointIds[id];
}

function setCheckpointDone(id, done) {
  if (done) state.progress.doneCheckpointIds[id] = true;
  else delete state.progress.doneCheckpointIds[id];
}

function buildTodayTasks(force = false) {
  const day = todayISO();
  const existing = state.tasks.byDate[day];
  if (existing && existing.length && !force) return existing;

  const dailyCount = clampInt(state.roadmap.dailyCount, 1, 10);
  const cps = state.roadmap.checkpoints || [];
  const undone = cps.filter((c) => !isCheckpointDone(c.id));
  const pick = undone.slice(0, dailyCount);

  const ids = pick.map((c) => c.id);
  state.tasks.byDate[day] = ids;
  saveState();
  return ids;
}

function getTodayTasks() {
  const day = todayISO();
  const ids = buildTodayTasks(false) || [];
  const map = new Map((state.roadmap.checkpoints || []).map((c) => [c.id, c]));
  return ids.map((id) => map.get(id)).filter(Boolean);
}

function computeDayProgress(dayISO) {
  const ids = state.tasks.byDate[dayISO] || [];
  const done = ids.filter((id) => isCheckpointDone(id)).length;
  return { done, total: ids.length };
}

function markDayDone() {
  const day = todayISO();
  const p = computeDayProgress(day);

  if (p.total === 0) {
    toast("No tasks for today yet.", "warn");
    return;
  }
  if (p.done < Math.max(1, Math.floor(p.total * 0.7))) {
    if (!confirm("You didn’t finish most tasks. Mark day done anyway?")) return;
  }

  if (state.streak.lastDoneDay === day) {
    toast("Already marked today as done.");
    return;
  }

  let nextCurrent = 1;
  if (state.streak.lastDoneDay) {
    const gap = daysBetweenISO(state.streak.lastDoneDay, day);
    if (gap === 1) nextCurrent = state.streak.current + 1;
    else nextCurrent = 1;
  }

  state.streak.current = nextCurrent;
  state.streak.best = Math.max(state.streak.best, nextCurrent);
  state.streak.lastDoneDay = day;
  saveState();

  renderStreak();
  toast(`Day complete. Streak: ${state.streak.current} day(s).`, "good");
}

/* ------------------------------ Reminders -------------------------------- */

let reminderTimer = null;

function supportsNotifications() {
  return "Notification" in window;
}

async function enableNotifications() {
  if (!supportsNotifications()) {
    toast("Notifications not supported in this browser.", "warn");
    return;
  }
  const res = await Notification.requestPermission();
  if (res !== "granted") {
    state.reminders.notificationsEnabled = false;
    saveState();
    toast("Notifications not enabled.", "warn");
    renderReminderUI();
    return;
  }
  state.reminders.notificationsEnabled = true;
  saveState();
  toast("Reminders enabled.");
  renderReminderUI();
  scheduleReminder();
}

function scheduleReminder() {
  clearTimeout(reminderTimer);

  if (!state.reminders.notificationsEnabled) return;
  if (!supportsNotifications() || Notification.permission !== "granted") return;

  const [hh, mm] = (state.reminders.time || "20:30").split(":").map((x) => parseInt(x, 10));
  const now = new Date();
  const next = new Date();
  next.setHours(Number.isFinite(hh) ? hh : 20, Number.isFinite(mm) ? mm : 30, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);

  const delay = Math.max(250, next.getTime() - now.getTime());
  reminderTimer = setTimeout(() => {
    fireReminder();
    scheduleReminder();
  }, delay);
}

function fireReminder() {
  const day = todayISO();
  if (state.reminders.lastNotifiedDay === day) return;

  const p = computeDayProgress(day);
  const remaining = Math.max(0, p.total - p.done);

  const title = "Back on Track — your daily checkpoint";
  const body =
    p.total === 0
      ? "Open the app to generate today’s tasks."
      : remaining === 0
        ? "You’re done for today. Mark the day complete and protect your streak."
        : `You have ${remaining} task(s) left today. Finish one now to keep your streak alive.`;

  try {
    // Use a simple notification (best effort: works when page is open).
    // For true background scheduled notifications, you’d need server/Push.
    new Notification(title, { body });
    state.reminders.lastNotifiedDay = day;
    saveState();
  } catch {
    // ignore
  }
}

function renderReminderUI() {
  const t = $("#reminderTime");
  if (t) t.value = state.reminders.time || "20:30";

  const btn = $("#notifyBtn");
  if (btn) {
    const enabled = state.reminders.notificationsEnabled && supportsNotifications() && Notification.permission === "granted";
    btn.textContent = enabled ? "Reminders on" : "Remind me";
  }
}

/* ------------------------------ Doubt Solver ----------------------------- */

function buildDoubtPrompt({ subject, doubt }) {
  const day = todayISO();
  return normalizeText(`
You are a strict but kind engineering tutor for an Indian college student.

Goal: help me solve my doubt with steps and clear reasoning.

Constraints:
- Keep it exam-oriented (most likely questions, shortcuts where valid).
- If it’s a numerical problem, show steps + final answer.
- If it’s theory, give a structured explanation + 5 quick revision bullets.
- Ask 1-2 clarifying questions ONLY if absolutely necessary.

Context:
- Date: ${day}
- Subject: ${subject || "Not specified"}

My doubt:
${doubt}
`);
}

const DOUBT_PROXY_URL = "/api/ask";

async function askAnthropicViaProxy({ subject, question }) {
  const resp = await fetch(DOUBT_PROXY_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subject, question }),
  });

  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    const msg = data?.error || `Proxy error (${resp.status})`;
    throw new Error(msg);
  }
  const text = String(data?.text || "").trim();
  if (!text) throw new Error("Empty response from proxy.");
  return text;
}

function offlineCoachAnswer(subject, doubt) {
  const cleanedDoubt = normalizeText(doubt);
  const rawSubject = (subject || "").trim();
  const sLower = `${rawSubject} ${cleanedDoubt}`.toLowerCase();

  const pick = (...arr) => arr.filter(Boolean);
  const hasAny = (t, words) => words.some((w) => t.includes(w));

  function section(title, lines) {
    return [`### ${title}`, ...lines.map((l) => (l.startsWith("- ") ? l : `- ${l}`)), ``].join("\n");
  }

  function topicMathBisection() {
    return [
      `### Bisection method (root finding)`,
      `- **Use when**: you need a real root of \(f(x)=0\) and you can find an interval \([a,b]\) with **opposite signs**: \(f(a)f(b)<0\).`,
      `- **Algorithm**: mid \(m=(a+b)/2\). If \(f(a)f(m)<0\), set \(b=m\); else set \(a=m\). Repeat until interval is small.`,
      `- **Error bound** after \(n\) steps: interval length \(=\\frac{b-a}{2^n}\). So to get tolerance \u03b5: \(n \\ge \\lceil \\log_2\\frac{b-a}{\\varepsilon}\\rceil\).`,
      `- **Exam tip**: Always show the sign check at each iteration in a small table (a, b, m, f(m)).`,
      ``,
    ].join("\n");
  }

  function topicMathDifferentiation() {
    return [
      `### Differentiation quick guide`,
      `- **Meaning**: derivative is rate of change / slope of tangent.`,
      `- **Rules**: chain rule is the most common source of mistakes.`,
      `- Basics: \(\\frac{d}{dx}(x^n)=nx^{n-1}\), \(\\frac{d}{dx}(\\sin x)=\\cos x\), \(\\frac{d}{dx}(e^x)=e^x\), \(\\frac{d}{dx}(\\ln x)=1/x\).`,
      `- **Chain**: if \(y=f(g(x))\), then \(dy/dx=f'(g(x))\\cdot g'(x)\).`,
      `- **Product**: \((uv)'=u'v+uv'\). **Quotient**: \((u/v)'=(u'v-uv')/v^2\).`,
      ``,
    ].join("\n");
  }

  function topicMathIntegration() {
    return [
      `### Integration quick guide`,
      `- **Meaning**: area / accumulation; inverse of differentiation.`,
      `- Basics: \u222b x^n dx = x^{n+1}/(n+1)+C (n≠−1), \u222b 1/x dx = ln|x|+C.`,
      `- **Substitution**: if you see \(f(g(x))g'(x)\), set \(u=g(x)\).`,
      `- **By parts**: \u222b u dv = uv − \u222b v du. Pick u = logs/inverse trig/algebraic; dv = exponential/trig.`,
      `- **Definite integral**: always substitute limits or convert back to x before applying limits.`,
      ``,
    ].join("\n");
  }

  function topicMathMatrix() {
    return [
      `### Matrices (common exam facts)`,
      `- **Order**: \(A_{m\\times n}B_{n\\times p}\) is defined; result is \(m\\times p\).`,
      `- **Determinant**: \(\\det(AB)=\\det(A)\\det(B)\). If det(A)=0 then A is singular (no inverse).`,
      `- **Inverse**: \(AA^{-1}=I\) exists only if det(A)≠0.`,
      `- **Eigen**: solve \(\\det(A-\\lambda I)=0\) for \u03bb; then \((A-\\lambda I)v=0\) for eigenvector v.`,
      `- **Row operations**: great for rank/inverse; keep track of what they do to det.`,
      ``,
    ].join("\n");
  }

  function topicElectronicsOhmKirchhoff() {
    return [
      `### Basic circuits: Ohm + Kirchhoff`,
      `- Ohm’s law: \(V=IR\). Power: \(P=VI=I^2R=V^2/R\).`,
      `- KCL: sum of currents entering a node = leaving.`,
      `- KVL: sum of voltage rises/drops around a loop = 0.`,
      `- Series: \(R_{eq}=R_1+R_2+...\). Parallel: \(1/R_{eq}=1/R_1+1/R_2+...\).`,
      `- **Exam tip**: choose current directions arbitrarily; a negative result just means opposite direction.`,
      ``,
    ].join("\n");
  }

  function topicElectronicsRC() {
    return [
      `### RC circuits (very common)`,
      `- Time constant: \(\\tau = RC\).`,
      `- Charging capacitor: \(v_C(t)=V(1-e^{-t/RC})\). Current \(i(t)=(V/R)e^{-t/RC}\).`,
      `- Discharging: \(v_C(t)=V_0 e^{-t/RC}\).`,
      `- At \(t=\\tau\): capacitor reaches ~63% (charging) or drops to ~37% (discharging).`,
      ``,
    ].join("\n");
  }

  function topicDSABinarySearch() {
    return [
      `### Binary search (when you see “sorted” / “minimum x such that…”)`,
      `- **Precondition**: monotonic / sorted.`,
      `- Mid: mid = low + (high-low)/2.`,
      `- Time: \(O(\\log n)\).`,
      `- Common bug**: infinite loop due to wrong mid update; always ensure low/high moves.`,
      ``,
    ].join("\n");
  }

  function topicDSAStacksQueues() {
    return [
      `### Stack / Queue quick reminders`,
      `- Stack (LIFO): used for parentheses, undo, function calls, monotonic stack problems.`,
      `- Queue (FIFO): BFS, scheduling; Deque helps with sliding window.`,
      `- Complexity: push/pop usually \(O(1)\) (array/linked list); beware resizing costs.`,
      ``,
    ].join("\n");
  }

  function topicDSAGraphs() {
    return [
      `### Graph basics (BFS/DFS)`,
      `- BFS: shortest path in unweighted graphs; uses queue.`,
      `- DFS: components, topological sort (DAG), cycle detection; uses stack/recursion.`,
      `- Complexity: \(O(V+E)\) with adjacency list.`,
      ``,
    ].join("\n");
  }

  function topicPhysicsKinematics() {
    return [
      `### Kinematics (straight-line motion)`,
      `- \(v=u+at\), \(s=ut+\\tfrac12at^2\), \(v^2=u^2+2as\).`,
      `- Always set a sign convention (positive direction) first.`,
      `- Units: m, s, m/s, m/s². Check dimensions at the end.`,
      ``,
    ].join("\n");
  }

  function topicPhysicsSHM() {
    return [
      `### SHM quick reminders`,
      `- \(x(t)=A\\sin(\\omega t+\\phi)\), \(v_{max}=A\\omega\), \(a=-\\omega^2 x\).`,
      `- Spring-mass: \(\\omega=\\sqrt{k/m}\), \(T=2\\pi\\sqrt{m/k}\).`,
      ``,
    ].join("\n");
  }

  const profiles = [
    {
      id: "math",
      match: (t) => /\b(math|mathematics|calculus|differential|integral|integration|limits|laplace|fourier|matrix|matrices|vector|linear algebra|probability|statistics)\b/i.test(t),
      tips: () =>
        pick(
          "Write the **given**, **to find**, and **constraints** (domain, continuity, boundary conditions).",
          "Before solving, note the **target form** (e.g., standard integrals, eigenvalue form, Laplace-table match).",
          "Do a 10‑second **sanity check**: units, sign, limiting case, or substitute back.",
        ),
      formulas: () =>
        pick(
          "Derivative basics: \(\\frac{d}{dx}x^n = nx^{n-1}\), product/quotient/chain rules.",
          "Integrals: \u222b x^n dx = x^{n+1}/(n+1) + C (n≠−1), \u222b 1/x dx = ln|x| + C.",
          "Matrix: \(\\det(AB)=\\det(A)\\det(B)\), eigen: \(A\\mathbf{v}=\\lambda\\mathbf{v}\).",
          "Probability: \(P(A\\cup B)=P(A)+P(B)-P(A\\cap B)\), Bayes \(P(A|B)=\\frac{P(B|A)P(A)}{P(B)}\).",
          "Laplace: \(\\mathcal{L}\\{1\\}=1/s\), \(\\mathcal{L}\\{e^{at}\\}=1/(s-a)\), \(\\mathcal{L}\\{\\sin at\\}=a/(s^2+a^2)\).",
        ),
    },
    {
      id: "physics",
      match: (t) => /\b(physics|mechanics|kinematics|dynamics|thermo|thermodynamics|electrostatics|current|circuits|optics|waves|oscillation|shm)\b/i.test(t),
      tips: () =>
        pick(
          "Start with a **diagram** (FBD / circuit / ray diagram).",
          "Write **knowns** with units; keep everything in SI early.",
          "Use **limiting cases** (t→0, R→0/∞) to catch algebra mistakes.",
        ),
      formulas: () =>
        pick(
          "Kinematics: \(v=u+at\), \(s=ut+\\tfrac12at^2\), \(v^2=u^2+2as\).",
          "Newton: \u03a3F = ma; work-energy: \(W=\\Delta K\).",
          "Ohm/Kirchhoff: \(V=IR\), KCL/KVL.",
          "Power: \(P=VI=I^2R=V^2/R\).",
          "Waves: \(v=f\\lambda\). SHM: \(\\omega=\\sqrt{k/m}\), \(T=2\\pi/\\omega\).",
        ),
    },
    {
      id: "dsa",
      match: (t) => /\b(dsa|data structures|algorithm|algorithms|array|linked list|stack|queue|heap|hash|hashing|tree|bst|graph|dfs|bfs|dp|dynamic programming|greedy|sorting|searching|big[- ]?o)\b/i.test(t),
      tips: () =>
        pick(
          "Clarify **input/output** and constraints first (n up to? sorted? duplicates?).",
          "Write the **brute force** quickly, then optimize using a pattern (two pointers, hash map, stack, BFS/DFS, DP).",
          "State time/space complexity explicitly (interview/exam scoring).",
        ),
      formulas: () =>
        pick(
          "Big‑O anchors: O(1), O(log n), O(n), O(n log n), O(n^2).",
          "Binary search mid: mid = low + (high-low)/2 (and requires sorted).",
          "DFS/BFS on graphs: O(V+E).",
          "Heap: push/pop O(log n). Hash map average O(1).",
          "DP: define state, transition, base cases; watch overlapping subproblems.",
        ),
    },
    {
      id: "signals",
      match: (t) => /\b(signals|systems|dsp|digital signal|lti|convolution|fourier transform|laplace|z-transform|sampling)\b/i.test(t),
      tips: () =>
        pick(
          "Check **LTI assumptions** before using convolution/transform properties.",
          "Write the signal as a sum of **known building blocks** (u(t), \u03b4(t), exponentials).",
          "Keep track of **ROC/causality/stability** when using Laplace/Z.",
        ),
      formulas: () =>
        pick(
          "Convolution: \(y(t)=x(t)*h(t)=\\int_{-\\infty}^{\\infty} x(\\tau)h(t-\\tau)d\\tau\).",
          "Fourier: \(X(\\omega)=\\int x(t)e^{-j\\omega t}dt\); time shift ↔ phase factor.",
          "Sampling: \(f_s \\ge 2f_{max}\) (Nyquist).",
          "Z-transform: \(X(z)=\\sum x[n]z^{-n}\); LTI difference eq → transfer function.",
        ),
    },
    {
      id: "chem",
      match: (t) => /\b(chemistry|organic|inorganic|physical chemistry|mole|molarity|ph|equilibrium|kinetics|thermochemistry)\b/i.test(t),
      tips: () =>
        pick(
          "List **given data** and convert units early (moles, molarity, pressure).",
          "For numericals, write the **governing equation** first, then substitute.",
          "For theory, use 3 buckets: **definition → mechanism/logic → exceptions**.",
        ),
      formulas: () =>
        pick(
          "Moles: n = m/M; molarity: \(M = n/V\).",
          "pH: \(pH=-\\log_{10}[H^+]\).",
          "Equilibrium: \(K_c = \\frac{\\prod [products]^{\\nu}}{\\prod [reactants]^{\\nu}}\).",
          "Kinetics (common): first order \(t_{1/2}=0.693/k\).",
        ),
    },
  ];

  const chosen = profiles.find((p) => p.match(sLower));
  const displaySubject = rawSubject || (chosen ? chosen.id.toUpperCase() : "your subject");

  if (!cleanedDoubt) {
    const subjectNudge = rawSubject ? `Subject: ${rawSubject}` : "Tip: add a subject (e.g., Math / DSA / Physics) for better offline help.";
    return `Paste your doubt (question + your attempt), then tap Solve.\n\n${subjectNudge}`;
  }

  // Keyword-based "intelligent" offline explainers for common engineering topics.
  const topicBlocks = [];

  if (hasAny(sLower, ["bisection"])) topicBlocks.push(topicMathBisection());
  if (hasAny(sLower, ["integration", "integral", "integrate"])) topicBlocks.push(topicMathIntegration());
  if (hasAny(sLower, ["differentiat", "derivative", "d/dx", "dy/dx"])) topicBlocks.push(topicMathDifferentiation());
  if (hasAny(sLower, ["matrix", "matrices", "determinant", "eigen"])) topicBlocks.push(topicMathMatrix());

  if (hasAny(sLower, ["ohm", "kirchhoff", "kcl", "kvl", "resistor", "circuit", "voltage", "current"])) topicBlocks.push(topicElectronicsOhmKirchhoff());
  if (hasAny(sLower, ["rc", "time constant", "capacitor", "charging", "discharging"])) topicBlocks.push(topicElectronicsRC());

  if (hasAny(sLower, ["binary search", "sorted", "monotonic"])) topicBlocks.push(topicDSABinarySearch());
  if (hasAny(sLower, ["stack", "queue", "deque"])) topicBlocks.push(topicDSAStacksQueues());
  if (hasAny(sLower, ["graph", "bfs", "dfs", "topological", "dijkstra"])) topicBlocks.push(topicDSAGraphs());

  if (hasAny(sLower, ["kinematics", "acceleration", "velocity", "displacement", "u+at"])) topicBlocks.push(topicPhysicsKinematics());
  if (hasAny(sLower, ["shm", "simple harmonic", "omega", "spring"])) topicBlocks.push(topicPhysicsSHM());

  const tips = chosen?.tips?.() || pick("Write the given + to-find clearly.", "Choose the simplest valid method first.", "Do a quick sanity check at the end.");
  const formulas = chosen?.formulas?.() || pick("Keep definitions and conditions of formulas in mind (domain/units/assumptions).");

  const outline = [
    `Offline doubt solver — here’s a marks-friendly response for **${displaySubject}**.`,
    ``,
    `### What to do next (fast)`,
    ...tips.map((t) => `- ${t}`),
    ``,
    ...(topicBlocks.length
      ? [
          `### Matched topic help (based on your keywords)`,
          `- Found: ${topicBlocks.length} topic(s).`,
          ``,
          ...topicBlocks,
        ]
      : []),
    `### Key formulas / reminders`,
    ...formulas.map((f) => `- ${f}`),
    ``,
    `### How to present the solution (marks-friendly)`,
    `- **Given / Required / Diagram (if needed)**`,
    `- **Formula / Concept used + condition** (when is it valid?)`,
    `- **Steps** (show substitutions clearly)`,
    `- **Final answer** + **sanity check**`,
    ``,
    `### Your doubt (what I’m responding to)`,
    cleanedDoubt.length > 800 ? `${cleanedDoubt.slice(0, 800)}…` : cleanedDoubt,
    ``,
    `If you paste your exact steps (even if wrong), I can pinpoint the first wrong step.`,
  ];

  return outline.join("\n");
}

async function solveDoubt() {
  const subject = ($("#doubtSubject")?.value || "").trim();
  const doubt = ($("#doubtText")?.value || "").trim();

  const ans = $("#doubtAnswer");
  if (!ans) return;
  ans.hidden = false;
  if (!normalizeText(doubt)) {
    ans.textContent = offlineCoachAnswer(subject, doubt);
    return;
  }

  ans.textContent = "Asking the tutor…";
  try {
    const text = await askAnthropicViaProxy({ subject, question: doubt });
    ans.textContent = text;
    toast("Answer ready.", "good");
  } catch (e) {
    ans.textContent = offlineCoachAnswer(subject, doubt);
    toast(`AI proxy unavailable — showed offline help instead. (${e?.message || "error"})`, "warn");
  }
}

async function copyDoubtPrompt() {
  const subject = ($("#doubtSubject")?.value || "").trim();
  const doubt = ($("#doubtText")?.value || "").trim();
  const promptText = buildDoubtPrompt({ subject, doubt });
  try {
    await navigator.clipboard.writeText(promptText);
    toast("Prompt copied.");
  } catch {
    toast("Could not copy. Your browser may block clipboard access.", "warn");
  }
}

/* ------------------------------ Import/Export ---------------------------- */

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `back-on-track_${todayISO()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function importDataFromFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const next = safeParse(String(reader.result || ""), null);
    if (!next || typeof next !== "object") {
      toast("Invalid file.", "warn");
      return;
    }
    state = { ...deepClone(DEFAULT_STATE), ...next };
    saveState();
    renderAll();
    toast("Imported.");
  };
  reader.readAsText(file);
}

/* ------------------------------ Rendering -------------------------------- */

function renderStreak() {
  const now = $("#streakNow");
  const best = $("#streakBest");
  if (now) now.textContent = String(state.streak.current || 0);
  if (best) best.textContent = String(state.streak.best || 0);
}

function renderSubjects() {
  const wrap = $("#subjectsWrap");
  if (!wrap) return;
  wrap.innerHTML = "";

  const list = state.syllabus.subjects || [];
  const pill = $("#subjectCountPill");
  if (pill) pill.textContent = String(list.length);

  if (!list.length) {
    wrap.innerHTML = `<div class="empty"><div class="empty__title">No subjects yet</div><div class="empty__text">Paste or upload your syllabus, then organize it by subject.</div></div>`;
    return;
  }

  for (const subj of list) {
    const el = document.createElement("div");
    el.className = "subject";
    el.innerHTML = `
      <div class="subject__top">
        <div>
          <div class="subject__name">${escapeHtml(subj.name)}</div>
          <div class="muted small">${(subj.units || []).length} unit(s)</div>
        </div>
        <div class="item__actions">
          <button class="btn btn--ghost" type="button" data-act="renameSubject" data-subj="${subj.id}">Rename</button>
          <button class="btn btn--danger" type="button" data-act="deleteSubject" data-subj="${subj.id}">Delete</button>
        </div>
      </div>
      <div class="subject__units"></div>
      <div class="row" style="margin-top:10px">
        <button class="btn" type="button" data-act="addUnit" data-subj="${subj.id}">Add unit</button>
      </div>
    `;
    const unitsWrap = $(".subject__units", el);

    for (const unit of subj.units || []) {
      const uel = document.createElement("div");
      uel.className = "unit";

      const topicPreview =
        (unit.topics || []).slice(0, 10).map((t, i) => `${i + 1}. ${t}`).join(" · ") || "No topics yet.";
      const more = (unit.topics || []).length > 10 ? ` · +${unit.topics.length - 10} more` : "";

      uel.innerHTML = `
        <div class="unit__row">
          <div class="unit__title">${escapeHtml(unit.title || "Unit")}</div>
          <div class="item__actions">
            <button class="btn btn--ghost" type="button" data-act="addTopic" data-subj="${subj.id}" data-unit="${unit.id}">Add topic</button>
            <button class="btn btn--danger" type="button" data-act="deleteUnit" data-subj="${subj.id}" data-unit="${unit.id}">Delete unit</button>
          </div>
        </div>
        <div class="unit__topics">${escapeHtml(topicPreview + more)}</div>
        <div class="row" style="margin-top:10px">
          ${(unit.topics || [])
            .slice(0, 6)
            .map(
              (t, idx) =>
                `<button class="chip chip--gold" type="button" data-act="deleteTopic" data-subj="${subj.id}" data-unit="${unit.id}" data-idx="${idx}" title="Tap to delete topic">${escapeHtml(t)}</button>`,
            )
            .join("")}
        </div>
      `;
      unitsWrap.appendChild(uel);
    }

    wrap.appendChild(el);
  }
}

function renderRoadmap() {
  const cps = state.roadmap.checkpoints || [];
  const wrap = $("#checkpointsWrap");
  if (!wrap) return;
  wrap.innerHTML = "";

  const done = cps.filter((c) => isCheckpointDone(c.id)).length;
  const pill = $("#checkpointPill");
  if (pill) pill.textContent = `${done} / ${cps.length}`;

  if (!cps.length) {
    wrap.innerHTML = `<div class="empty"><div class="empty__title">No checkpoints yet</div><div class="empty__text">Generate a roadmap from your syllabus to create bite-sized checkpoints.</div></div>`;
    return;
  }

  for (const c of cps) {
    const isDone = isCheckpointDone(c.id);
    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `
      <div class="item__left">
        <button class="check ${isDone ? "check--done" : ""}" type="button" data-act="toggleCheckpoint" data-id="${c.id}" aria-label="Toggle done">
          ${isDone ? "✓" : ""}
        </button>
        <div style="min-width:0">
          <div class="item__title">${escapeHtml(c.title)}</div>
          <div class="item__meta">${escapeHtml(c.subject)} · ${escapeHtml(c.unit || "")} · ~${c.estimateMin || 35} min</div>
        </div>
      </div>
      <div class="item__actions">
        <span class="chip ${isDone ? "chip--good" : "chip--orange"}">${isDone ? "Done" : "Next"}</span>
      </div>
    `;
    wrap.appendChild(el);
  }
}

function renderToday() {
  const pill = $("#todayDatePill");
  if (pill) pill.textContent = todayISO();

  const list = $("#todayList");
  const empty = $("#todayEmpty");
  if (!list || !empty) return;

  const tasks = getTodayTasks();
  const anyRoadmap = (state.roadmap.checkpoints || []).length > 0;

  list.innerHTML = "";
  if (!tasks.length) {
    empty.hidden = false;
    if (!anyRoadmap) empty.querySelector(".empty__text").textContent = "Add syllabus, generate a roadmap, then your daily tasks appear here.";
    else empty.querySelector(".empty__text").textContent = "You’ve completed everything. Reset or add more topics.";
    return;
  }
  empty.hidden = true;

  for (const c of tasks) {
    const done = isCheckpointDone(c.id);
    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `
      <div class="item__left">
        <button class="check ${done ? "check--done" : ""}" type="button" data-act="toggleCheckpoint" data-id="${c.id}">
          ${done ? "✓" : ""}
        </button>
        <div style="min-width:0">
          <div class="item__title">${escapeHtml(c.title)}</div>
          <div class="item__meta">${escapeHtml(c.subject)} · ~${c.estimateMin || 35} min</div>
        </div>
      </div>
      <div class="item__actions">
        <span class="chip ${done ? "chip--good" : "chip--gold"}">${done ? "Done" : "Do now"}</span>
      </div>
    `;
    list.appendChild(el);
  }

  const p = computeDayProgress(todayISO());
  const prog = $("#todayProgress");
  if (prog) prog.textContent = `${p.done}/${p.total} done`;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderSettings() {
  const n = $("#nameInput");
  const b = $("#branchInput");
  if (n) n.value = state.profile.name || "";
  if (b) b.value = state.profile.branch || "";

  const targetDate = $("#targetDate");
  const dailyCount = $("#dailyCount");
  if (targetDate) targetDate.value = state.roadmap.targetDate || "";
  if (dailyCount) dailyCount.value = String(state.roadmap.dailyCount || 3);
}

function renderAll() {
  renderStreak();
  renderReminderUI();
  renderSubjects();
  renderRoadmap();
  renderToday();
  renderSettings();
}

/* ------------------------------ Event wiring ----------------------------- */

function onActionClick(e) {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  const act = t.dataset.act;
  if (!act) return;

  const subj = t.dataset.subj || "";
  const unit = t.dataset.unit || "";

  if (act === "renameSubject") renameSubject(subj);
  if (act === "deleteSubject") deleteSubject(subj);
  if (act === "addUnit") addUnit(subj);
  if (act === "addTopic") addTopic(subj, unit);
  if (act === "deleteUnit") deleteUnit(subj, unit);
  if (act === "deleteTopic") deleteTopic(subj, unit, clampInt(t.dataset.idx, 0, 1e9));
  if (act === "toggleCheckpoint") {
    const id = t.dataset.id;
    if (!id) return;
    const next = !isCheckpointDone(id);
    setCheckpointDone(id, next);
    saveState();
    renderRoadmap();
    renderToday();
  }
}

function initEvents() {
  document.addEventListener("click", onActionClick);

  $("#parseSyllabusBtn")?.addEventListener("click", () => {
    const text = $("#syllabusText")?.value || "";
    const subjects = parseSyllabusText(text);
    if (!subjects.length) {
      toast("Could not detect subjects. Try adding “SUBJECT: …” headers.", "warn");
      return;
    }
    state.syllabus.rawText = normalizeText(text);
    state.syllabus.subjects = subjects;
    saveState();
    renderAll();
    toast("Organized into subjects.");
  });

  $("#addSubjectBtn")?.addEventListener("click", addSubjectManually);

  $("#clearSyllabusBtn")?.addEventListener("click", () => {
    if (!confirm("Clear pasted syllabus text and subjects?")) return;
    state.syllabus.rawText = "";
    state.syllabus.subjects = [];
    saveState();
    $("#syllabusText").value = "";
    renderAll();
    toast("Cleared.");
  });

  $("#syllabusFile")?.addEventListener("change", async (e) => {
    const file = e.target?.files?.[0];
    if (!file) return;
    const text = await file.text();
    $("#syllabusText").value = text;
    toast("Loaded file. Now tap “Organize by subject”.");
  });

  $("#generateRoadmapBtn")?.addEventListener("click", () => {
    state.roadmap.targetDate = $("#targetDate")?.value || "";
    state.roadmap.dailyCount = clampInt($("#dailyCount")?.value ?? 3, 1, 10);
    saveState();
    generateCheckpoints();
  });

  $("#resetProgressBtn")?.addEventListener("click", resetProgress);

  $("#regenTodayBtn")?.addEventListener("click", () => {
    buildTodayTasks(true);
    renderToday();
    toast("Today rebuilt.");
  });

  $("#markDayDoneBtn")?.addEventListener("click", markDayDone);

  $("#saveReminderBtn")?.addEventListener("click", () => {
    const t = $("#reminderTime")?.value || "20:30";
    state.reminders.time = t;
    saveState();
    renderReminderUI();
    scheduleReminder();
    toast("Reminder time saved.");
  });

  $("#notifyBtn")?.addEventListener("click", enableNotifications);

  $("#solveBtn")?.addEventListener("click", solveDoubt);
  $("#copyPromptBtn")?.addEventListener("click", copyDoubtPrompt);

  $("#saveSettingsBtn")?.addEventListener("click", () => {
    state.profile.name = ($("#nameInput")?.value || "").trim();
    state.profile.branch = ($("#branchInput")?.value || "").trim();

    state.roadmap.targetDate = $("#targetDate")?.value || "";
    state.roadmap.dailyCount = clampInt($("#dailyCount")?.value ?? 3, 1, 10);
    saveState();
    toast("Settings saved.");
  });

  $("#wipeAllBtn")?.addEventListener("click", () => {
    if (!confirm("Wipe everything? This cannot be undone.")) return;
    localStorage.removeItem(STORAGE_KEY);
    state = deepClone(DEFAULT_STATE);
    saveState();
    renderAll();
    toast("All data wiped.");
  });

  $("#exportBtn")?.addEventListener("click", exportData);
  $("#importBtn")?.addEventListener("click", () => $("#importFile")?.click());
  $("#importFile")?.addEventListener("change", (e) => {
    const f = e.target?.files?.[0];
    if (f) importDataFromFile(f);
    e.target.value = "";
  });
}

/* ------------------------------ PWA install ------------------------------ */

let deferredPrompt = null;

function initPWA() {
  const installBtn = $("#installBtn");

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (installBtn) installBtn.hidden = false;
  });

  installBtn?.addEventListener("click", async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice.catch(() => null);
    deferredPrompt = null;
    installBtn.hidden = true;
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      // non-fatal
    });
  }
}

/* --------------------------------- Boot --------------------------------- */

function boot() {
  initNav();
  initEvents();
  initPWA();

  // Load any stored syllabus text into textarea.
  if ($("#syllabusText") && state.syllabus.rawText && !$("#syllabusText").value) {
    $("#syllabusText").value = state.syllabus.rawText;
  }

  // Sync UI for roadmap inputs.
  if ($("#dailyCount")) $("#dailyCount").value = String(state.roadmap.dailyCount || 3);
  if ($("#targetDate")) $("#targetDate").value = state.roadmap.targetDate || "";

  renderAll();
  buildTodayTasks(false);
  renderToday();
  renderStreak();

  // If permission already granted, reflect it.
  if (supportsNotifications() && Notification.permission === "granted") {
    state.reminders.notificationsEnabled = true;
    saveState();
  }
  renderReminderUI();
  scheduleReminder();
}

document.addEventListener("DOMContentLoaded", boot);

