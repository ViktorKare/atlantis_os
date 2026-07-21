# Mobile Responsive Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single phone-width layout mode to the app: a hamburger-collapsible nav rail, drill-down list→detail views for Agents/Skills/Tasks/Plans, overlay sidebar drawers for Chat/Models/Pipelines, and fluid composer/bubble widths — without redesigning the inherently desktop-shaped Pipelines canvas or code editor multi-pane layout.

**Architecture:** One `@media (max-width: 720px)` tier in `web/style.css`. The nav rail becomes a fixed-position overlay toggled by a new hamburger button, closed automatically by a one-line hook in the existing `switchSection()`. Agents/Skills/Tasks/Plans already share one structural pattern (`.section-sidebar` list + `.editor-area` detail pane that starts as a `<p class="empty-state">` placeholder) — drill-down between them is expressed as pure CSS using `:has()`, with one small shared "← Back" click-dispatch table in `web/app.js` (no per-section duplication of render logic). Chat/Models/Pipelines sidebars become slide-over drawers via one shared `bindMobileSidebarToggle()` helper reused three times. Pipelines' node canvas and the code editor's pane system are untouched — they get `overflow: auto` for pinch/scroll rather than a redesign, per the approved design scope.

**Tech Stack:** Vanilla CSS media queries (`:has()` — broadly supported in all evergreen browsers as of this app's target environment), vanilla JS, no bundler.

## Global Constraints

- Single breakpoint: `@media (max-width: 720px)`. No separate tablet tier.
- Pipelines' node canvas and the code editor's multi-pane layout are **not** redesigned — best-effort scroll/pinch-zoom only, per the approved design.
- No changes to desktop-width behavior — every rule in this plan lives inside the new media query (or is a no-op above it).
- No automated test suite in this repo — verification is `node --check` syntax validation plus a manual walkthrough at both desktop and phone widths (via browser dev-tools device emulation or an actual narrow window), matching the convention in `docs/superpowers/plans/2026-07-14-change-workspace-folder-plan.md`.

---

### Task 1: Hamburger nav drawer

**Files:**
- Modify: `web/index.html:12-16` (add hamburger button + backdrop around `#nav-rail`)
- Modify: `web/style.css` (new media-query rules, appended at end of file)
- Modify: `web/app.js:123-124` (`switchSection`), plus new DOM refs/listeners near `web/app.js:96-101`

**Interfaces:**
- Produces: `closeMobileNav()` — module-level function, called from `switchSection()` in this task; not consumed elsewhere in this plan.

- [ ] **Step 1: Add the hamburger button and backdrop**

`web/index.html` currently opens the shell (`web/index.html:12-16`):

```html
<body>
  <div id="app">

    <!-- ── Nav rail ─────────────────────────────────────────── -->
    <nav id="nav-rail">
```

Replace with:

```html
<body>
  <div id="app">

    <button id="mobile-nav-toggle" title="Menu">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
    </button>
    <div id="mobile-nav-backdrop"></div>

    <!-- ── Nav rail ─────────────────────────────────────────── -->
    <nav id="nav-rail">
```

- [ ] **Step 2: Verify HTML edit landed**

```bash
cd /Volumes/library/projects/atlantis_os
python3 -c "s=open('web/index.html').read(); assert '<button id=\"mobile-nav-toggle\"' in s and '<div id=\"mobile-nav-backdrop\"></div>' in s"
```

Expected: no output.

- [ ] **Step 3: Add mobile nav CSS**

Append to `web/style.css`:

```css
/* ── Mobile phone layout ──────────────────────────────────────────────────
   Single breakpoint — no separate tablet tier. Pipelines' node canvas and
   the code editor's pane system are intentionally left un-redesigned here;
   they get overflow:auto below instead. */

#mobile-nav-toggle,
#mobile-nav-backdrop {
  display: none;
}

@media (max-width: 720px) {
  #mobile-nav-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    position: fixed;
    top: 10px;
    left: 10px;
    width: 36px;
    height: 36px;
    border-radius: 8px;
    background: var(--glass-bg2);
    backdrop-filter: blur(14px);
    border: 1px solid var(--border);
    color: var(--text);
    z-index: 700;
    cursor: pointer;
  }
  #mobile-nav-toggle svg { width: 18px; height: 18px; }

  #mobile-nav-backdrop {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 550;
  }
  #mobile-nav-backdrop.open { display: block; }

  #nav-rail {
    position: fixed;
    top: 0; bottom: 0; left: 0;
    width: 220px;
    z-index: 600;
    transform: translateX(-100%);
    transition: transform 0.2s ease;
  }
  #nav-rail.open { transform: translateX(0); }
}
```

- [ ] **Step 4: Wire the toggle + close-on-navigate**

`web/app.js`'s DOM refs currently include (`web/app.js:96-98`):

```javascript
const chatSidebar        = document.getElementById('sidebar');
const sidebarToggleBtn    = document.getElementById('sidebar-toggle-btn');
const threadSwitcherBtn   = document.getElementById('thread-switcher-btn');
```

Replace with:

```javascript
const chatSidebar        = document.getElementById('sidebar');
const sidebarToggleBtn    = document.getElementById('sidebar-toggle-btn');
const threadSwitcherBtn   = document.getElementById('thread-switcher-btn');
const mobileNavToggle   = document.getElementById('mobile-nav-toggle');
const mobileNavBackdrop = document.getElementById('mobile-nav-backdrop');
const navRailEl         = document.getElementById('nav-rail');

function closeMobileNav() {
  navRailEl.classList.remove('open');
  mobileNavBackdrop.classList.remove('open');
}
mobileNavToggle.addEventListener('click', () => {
  navRailEl.classList.toggle('open');
  mobileNavBackdrop.classList.toggle('open');
});
mobileNavBackdrop.addEventListener('click', closeMobileNav);
```

`switchSection()` currently starts (`web/app.js:123-124`):

```javascript
function switchSection(name) {
  const curEl = document.getElementById(`section-${activeSection}`);
```

Replace with:

```javascript
function switchSection(name) {
  closeMobileNav();
  const curEl = document.getElementById(`section-${activeSection}`);
```

- [ ] **Step 5: Verify syntax**

```bash
cd /Volumes/library/projects/atlantis_os
node --check web/app.js
```

Expected: no output.

- [ ] **Step 6: Manual walkthrough**

```bash
cd /Volumes/library/projects/atlantis_os
python3 launcher.py
```

Open the app in a browser, use dev-tools device emulation (or resize the window) to under 720px wide:
1. Confirm `#nav-rail` is hidden and the hamburger button appears top-left.
2. Tap it — confirm the nav rail slides in with a dark backdrop behind it.
3. Tap the backdrop — confirm it closes.
4. Tap it open again, tap a section icon — confirm it navigates AND the drawer closes automatically.
5. Widen the window back above 720px — confirm the hamburger disappears and the nav rail returns to its normal permanent desktop position.

- [ ] **Step 7: Commit**

```bash
git add web/index.html web/style.css web/app.js
git commit -m "Add hamburger overlay nav drawer for phone-width viewports"
```

---

### Task 2: Drill-down list→detail (Agents, Skills, Tasks, Plans)

**Files:**
- Modify: `web/index.html:225-267` (insert a `.mobile-back-btn` into each of the four sections)
- Modify: `web/style.css` (new media-query rules)
- Modify: `web/app.js` (new dispatch table + wiring, added near the end of `init()`-adjacent top-level code — see Step 3)

**Interfaces:** none produced/consumed beyond this task — self-contained, driven entirely by each section's existing `active*Id`/`active*Name` globals and `render*List()` functions, which are not modified.

- [ ] **Step 1: Add a "← Back" button to each of the four sections**

`web/index.html` currently reads (`web/index.html:225-267`):

```html
    <!-- ── Agents ────────────────────────────────────────────── -->
    <div id="section-agents" class="section">
      <aside class="section-sidebar">
        <button id="new-agent-btn">+ New agent</button>
        <ul id="agent-list"></ul>
      </aside>
      <div id="agents-main" class="editor-area">
        <p class="empty-state">Select an agent or create a new one</p>
      </div>
    </div>

    <!-- ── Skills ────────────────────────────────────────────── -->
    <div id="section-skills" class="section">
      <aside class="section-sidebar">
        <button id="new-skill-btn">+ New skill</button>
        <ul id="skill-list"></ul>
      </aside>
      <div id="skills-main" class="editor-area">
        <p class="empty-state">Select a skill or create a new one</p>
      </div>
    </div>

    <!-- ── Tasks ─────────────────────────────────────────────── -->
    <div id="section-tasks" class="section">
      <aside class="section-sidebar">
        <button id="new-task-btn">+ New task</button>
        <ul id="task-list"></ul>
      </aside>
      <div id="tasks-main" class="editor-area">
        <p class="empty-state">Select a task or create a new one</p>
      </div>
    </div>

    <!-- ── Plans ───────────────────────────────────────────────── -->
    <div id="section-plans" class="section">
      <aside class="section-sidebar">
        <button id="new-plan-btn">+ New plan</button>
        <ul id="plan-list"></ul>
      </aside>
      <div id="plans-main" class="editor-area plans-area">
        <p class="empty-state">Select a plan or create a new one</p>
      </div>
    </div>
```

Replace with:

```html
    <!-- ── Agents ────────────────────────────────────────────── -->
    <div id="section-agents" class="section">
      <aside class="section-sidebar">
        <button id="new-agent-btn">+ New agent</button>
        <ul id="agent-list"></ul>
      </aside>
      <button type="button" class="mobile-back-btn" data-target="agents">← Back</button>
      <div id="agents-main" class="editor-area">
        <p class="empty-state">Select an agent or create a new one</p>
      </div>
    </div>

    <!-- ── Skills ────────────────────────────────────────────── -->
    <div id="section-skills" class="section">
      <aside class="section-sidebar">
        <button id="new-skill-btn">+ New skill</button>
        <ul id="skill-list"></ul>
      </aside>
      <button type="button" class="mobile-back-btn" data-target="skills">← Back</button>
      <div id="skills-main" class="editor-area">
        <p class="empty-state">Select a skill or create a new one</p>
      </div>
    </div>

    <!-- ── Tasks ─────────────────────────────────────────────── -->
    <div id="section-tasks" class="section">
      <aside class="section-sidebar">
        <button id="new-task-btn">+ New task</button>
        <ul id="task-list"></ul>
      </aside>
      <button type="button" class="mobile-back-btn" data-target="tasks">← Back</button>
      <div id="tasks-main" class="editor-area">
        <p class="empty-state">Select a task or create a new one</p>
      </div>
    </div>

    <!-- ── Plans ───────────────────────────────────────────────── -->
    <div id="section-plans" class="section">
      <aside class="section-sidebar">
        <button id="new-plan-btn">+ New plan</button>
        <ul id="plan-list"></ul>
      </aside>
      <button type="button" class="mobile-back-btn" data-target="plans">← Back</button>
      <div id="plans-main" class="editor-area plans-area">
        <p class="empty-state">Select a plan or create a new one</p>
      </div>
    </div>
```

- [ ] **Step 2: Add the drill-down CSS**

Append this as a new, self-contained block at the end of `web/style.css` (a separate `@media` block with the same query as Task 1's is valid CSS and applies identically — no need to locate/edit Task 1's block):

```css
@media (max-width: 720px) {
  /* Drill-down: list↔detail sections that share the .section-sidebar +
     .editor-area (with a leading <p class="empty-state">) structure. */
  .section-sidebar { width: 100%; }
  .editor-area { display: none; }
  .mobile-back-btn {
    display: none;
    width: 100%;
    padding: 10px 16px;
    background: var(--bg2);
    border: none;
    border-bottom: 1px solid var(--border);
    color: var(--text);
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  .section:has(.editor-area > :not(.empty-state)) .editor-area {
    display: flex;
    flex-direction: column;
  }
  .section:has(.editor-area > :not(.empty-state)) .section-sidebar {
    display: none;
  }
  .section:has(.editor-area > :not(.empty-state)) .mobile-back-btn {
    display: block;
  }
}
```

- [ ] **Step 3: Wire the back buttons**

Add this near the end of `web/app.js` (right after the `closeMobileNav`/`mobileNavToggle` wiring added in Task 1, Step 4):

```javascript
const MOBILE_BACK_RESET = {
  agents: () => {
    activeAgentId = null;
    document.getElementById('agents-main').innerHTML = '<p class="empty-state">Select an agent or create a new one</p>';
    renderAgentList();
  },
  skills: () => {
    activeSkillId = null;
    document.getElementById('skills-main').innerHTML = '<p class="empty-state">Select a skill or create a new one</p>';
    renderSkillList();
  },
  tasks: () => {
    activeTaskId = null;
    document.getElementById('tasks-main').innerHTML = '<p class="empty-state">Select a task or create a new one</p>';
    renderTaskList();
  },
  plans: () => {
    activePlanName = null;
    document.getElementById('plans-main').innerHTML = '<p class="empty-state">Select a plan or create a new one</p>';
    renderPlanList();
  },
};
document.querySelectorAll('.mobile-back-btn').forEach(btn => {
  btn.addEventListener('click', () => MOBILE_BACK_RESET[btn.dataset.target]?.());
});
```

- [ ] **Step 4: Verify syntax**

```bash
cd /Volumes/library/projects/atlantis_os
node --check web/app.js
```

Expected: no output.

- [ ] **Step 5: Manual walkthrough**

At a phone-width viewport:
1. Open **Agents** — confirm only the agent list shows, full width, no visible detail pane.
2. Tap an agent — confirm the list hides and the editor form shows full width with a "← Back" button above it.
3. Tap "← Back" — confirm it returns to the list, and the agent is deselected (no `.active` highlight left behind — click it again to confirm it still opens correctly).
4. Repeat for Skills, Tasks, and Plans.
5. Tap "+ New agent" (and the equivalent for the other three) from the list view — confirm the detail pane opens the same way as selecting an existing item (proves the `:has()` rule reacts to any populated content, not just selection).
6. Widen back above 720px — confirm the desktop two-pane layout is unaffected (list and detail visible side by side, no back button shown).

- [ ] **Step 6: Commit**

```bash
git add web/index.html web/style.css web/app.js
git commit -m "Add mobile drill-down list/detail views for Agents, Skills, Tasks, Plans"
```

---

### Task 3: Sidebar drawers — Chat, Models, Pipelines

**Files:**
- Modify: `web/index.html:160-167` (Chat sidebar + backdrop), `web/index.html:443-447` (Models toolbar — add toggle), `web/index.html:272-284,290-296` (Pipelines sidebar backdrop + toolbar toggle)
- Modify: `web/style.css` (new media-query rules)
- Modify: `web/app.js` (new `bindMobileSidebarToggle()` helper; rewire `sidebarToggleBtn`; wire the two new toggle buttons)

**Interfaces:**
- Produces: `bindMobileSidebarToggle(toggleBtn, sidebarEl, backdropEl)` — module-level function, attaches a click handler to `toggleBtn` that toggles `.mobile-open` on both `sidebarEl` and `backdropEl`, plus a click handler on `backdropEl` that closes it. Used three times in this task (Chat, Models, Pipelines) — no other task depends on it.

- [ ] **Step 1: Chat — add a backdrop element**

`web/index.html`'s Chat section currently opens (`web/index.html:160-167`):

```html
    <div id="section-chat" class="section">
      <aside id="sidebar">
        <div id="new-chat-row">
          <button id="new-chat-btn">+ New chat</button>
          <button id="new-temp-chat-btn" title="Not saved — gone once you leave this chat">+ Temp chat</button>
        </div>
        <ul id="thread-list"></ul>
      </aside>
```

Replace with:

```html
    <div id="section-chat" class="section">
      <aside id="sidebar">
        <div id="new-chat-row">
          <button id="new-chat-btn">+ New chat</button>
          <button id="new-temp-chat-btn" title="Not saved — gone once you leave this chat">+ Temp chat</button>
        </div>
        <ul id="thread-list"></ul>
      </aside>
      <div id="sidebar-mobile-backdrop" class="mobile-sidebar-backdrop"></div>
```

- [ ] **Step 2: Models — add a mobile toggle button**

`web/index.html`'s Models toolbar currently reads (`web/index.html:443-447`):

```html
      <div id="models-main">
        <div id="models-toolbar">
          <input type="search" id="models-search-input" placeholder="Search the Ollama library… (Enter to search)">
          <div id="models-hw-chips"></div>
        </div>
```

Replace with:

```html
      <div id="models-main">
        <div id="models-toolbar">
          <button type="button" id="models-sidebar-toggle-btn" class="mobile-sidebar-toggle-btn" title="Installed models">☰</button>
          <input type="search" id="models-search-input" placeholder="Search the Ollama library… (Enter to search)">
          <div id="models-hw-chips"></div>
        </div>
```

Add its backdrop right after `#models-sidebar`'s closing tag. `web/index.html`'s Models sidebar currently reads (`web/index.html:438-442`):

```html
    <div id="section-models" class="section">
      <div id="models-sidebar">
        <div id="models-sidebar-hdr">Installed <span id="models-installed-count"></span></div>
        <div id="models-installed-list"></div>
      </div>
```

Replace with:

```html
    <div id="section-models" class="section">
      <div id="models-sidebar">
        <div id="models-sidebar-hdr">Installed <span id="models-installed-count"></span></div>
        <div id="models-installed-list"></div>
      </div>
      <div id="models-sidebar-backdrop" class="mobile-sidebar-backdrop"></div>
```

- [ ] **Step 3: Pipelines — add a mobile toggle button**

`web/index.html`'s Pipelines toolbar currently reads (`web/index.html:290-296`):

```html
        <div id="pipe-canvas-area">
          <div id="pipe-toolbar">
            <span id="pipe-name-label" class="pipe-name-label">No pipeline selected</span>
            <div id="pipe-mode-toggle">
              <button id="pipe-mode-edit" class="pipe-mode-btn active" disabled title="Edit the pipeline">✎ Edit</button>
              <button id="pipe-mode-run"  class="pipe-mode-btn" disabled title="View the latest run">◉ Run</button>
            </div>
```

Replace with:

```html
        <div id="pipe-canvas-area">
          <div id="pipe-toolbar">
            <button type="button" id="pipe-sidebar-toggle-btn" class="mobile-sidebar-toggle-btn" title="Pipeline list">☰</button>
            <span id="pipe-name-label" class="pipe-name-label">No pipeline selected</span>
            <div id="pipe-mode-toggle">
              <button id="pipe-mode-edit" class="pipe-mode-btn active" disabled title="Edit the pipeline">✎ Edit</button>
              <button id="pipe-mode-run"  class="pipe-mode-btn" disabled title="View the latest run">◉ Run</button>
            </div>
```

Add its backdrop right after `#pipe-sidebar`'s closing `</div>`. That block currently reads (`web/index.html:272-284`):

```html
      <div id="pipe-sidebar">
        <div id="pipe-sidebar-header">
          <span>Pipelines</span>
          <button id="pipe-new-btn" title="New pipeline">+</button>
        </div>
        <div id="pipe-list"></div>
        <div id="pipe-runs-header" class="hidden">
          <button id="pipe-back-btn" title="Back to pipelines">←</button>
          <span id="pipe-runs-title">Runs</span>
          <button id="pipe-runs-del-btn" title="Delete all runs">🗑</button>
        </div>
        <div id="pipe-run-list" class="hidden"></div>
      </div>
```

Replace with:

```html
      <div id="pipe-sidebar">
        <div id="pipe-sidebar-header">
          <span>Pipelines</span>
          <button id="pipe-new-btn" title="New pipeline">+</button>
        </div>
        <div id="pipe-list"></div>
        <div id="pipe-runs-header" class="hidden">
          <button id="pipe-back-btn" title="Back to pipelines">←</button>
          <span id="pipe-runs-title">Runs</span>
          <button id="pipe-runs-del-btn" title="Delete all runs">🗑</button>
        </div>
        <div id="pipe-run-list" class="hidden"></div>
      </div>
      <div id="pipe-sidebar-backdrop" class="mobile-sidebar-backdrop"></div>
```

- [ ] **Step 4: Verify HTML edits landed**

```bash
cd /Volumes/library/projects/atlantis_os
python3 -c "
s = open('web/index.html').read()
for needle in ['id=\"sidebar-mobile-backdrop\"', 'id=\"models-sidebar-toggle-btn\"', 'id=\"models-sidebar-backdrop\"', 'id=\"pipe-sidebar-toggle-btn\"', 'id=\"pipe-sidebar-backdrop\"']:
    assert needle in s, needle
print('ok')
"
```

Expected: `ok`.

- [ ] **Step 5: Add drawer CSS**

Append this as a new, self-contained block at the end of `web/style.css`:

```css
@media (max-width: 720px) {
  /* Sidebar drawers: Chat's thread list, Models' installed list, Pipelines' list */
  .mobile-sidebar-toggle-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 6px;
    background: var(--bg3);
    border: 1px solid var(--border);
    color: var(--text);
    cursor: pointer;
    flex-shrink: 0;
  }
  .mobile-sidebar-backdrop {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 450;
  }
  .mobile-sidebar-backdrop.open { display: block; }

  #sidebar, #models-sidebar, #pipe-sidebar {
    position: fixed;
    top: 0; bottom: 0; left: 0;
    width: 85vw;
    max-width: 320px;
    z-index: 500;
    transform: translateX(-100%);
    transition: transform 0.2s ease;
  }
  #sidebar.mobile-open, #models-sidebar.mobile-open, #pipe-sidebar.mobile-open {
    transform: translateX(0);
  }
}
```

`.mobile-sidebar-toggle-btn` also needs to stay hidden *above* the breakpoint (it's only ever meant to exist inside the media query, but the class itself carries no display rule outside it). Task 1, Step 3 added this rule to `web/style.css`:

```css
#mobile-nav-toggle,
#mobile-nav-backdrop {
  display: none;
}
```

Change it to:

```css
#mobile-nav-toggle,
#mobile-nav-backdrop,
.mobile-sidebar-toggle-btn,
.mobile-sidebar-backdrop {
  display: none;
}
```

- [ ] **Step 6: Add the shared toggle helper and wire all three sidebars**

`web/app.js`'s existing Chat sidebar toggle currently reads (`web/app.js:1888-1890`, unchanged since Task 1/2 didn't touch it):

```javascript
sidebarToggleBtn.addEventListener('click', () => {
  chatSidebar.classList.toggle('collapsed');
});
```

Replace with:

```javascript
function bindMobileSidebarToggle(toggleBtn, sidebarEl, backdropEl) {
  toggleBtn.addEventListener('click', () => {
    sidebarEl.classList.toggle('mobile-open');
    backdropEl.classList.toggle('open');
  });
  backdropEl.addEventListener('click', () => {
    sidebarEl.classList.remove('mobile-open');
    backdropEl.classList.remove('open');
  });
}

sidebarToggleBtn.addEventListener('click', () => {
  chatSidebar.classList.toggle('collapsed');
});
bindMobileSidebarToggle(sidebarToggleBtn, chatSidebar, document.getElementById('sidebar-mobile-backdrop'));

bindMobileSidebarToggle(
  document.getElementById('models-sidebar-toggle-btn'),
  document.getElementById('models-sidebar'),
  document.getElementById('models-sidebar-backdrop'),
);
bindMobileSidebarToggle(
  document.getElementById('pipe-sidebar-toggle-btn'),
  document.getElementById('pipe-sidebar'),
  document.getElementById('pipe-sidebar-backdrop'),
);
```

Note: `sidebarToggleBtn` now has two independent listeners — the original one (toggles `.collapsed`, which is what the existing *desktop* width-collapse CSS keys off) and the new one from `bindMobileSidebarToggle` (toggles `.mobile-open`/backdrop, which is what the *mobile* drawer CSS from Step 5 keys off). Both fire on every click, but each only has a visual effect at its own breakpoint, so they don't conflict.

- [ ] **Step 7: Verify syntax**

```bash
cd /Volumes/library/projects/atlantis_os
node --check web/app.js
```

Expected: no output.

- [ ] **Step 8: Manual walkthrough**

At a phone-width viewport:
1. Open **Chat** — confirm the thread list is hidden by default and the chat window takes the full width.
2. Tap the existing sidebar toggle button (thread-list icon in the toolbar) — confirm the thread list slides in as an overlay with a backdrop; tap the backdrop to close it.
3. Open **Models** — confirm the installed-models list is hidden by default; tap the new "☰" button in the toolbar — confirm the same slide-over behavior.
4. Open **Pipelines** — confirm the pipeline list is hidden by default; tap the new "☰" button — confirm the same slide-over behavior, and that selecting a pipeline from the drawer still works (canvas loads, drawer can be manually closed afterward).
5. Widen back above 720px — confirm all three sidebars return to their normal permanent desktop position and the new mobile-only toggle buttons disappear.

- [ ] **Step 9: Commit**

```bash
git add web/index.html web/style.css web/app.js
git commit -m "Add overlay sidebar drawers for Chat, Models, and Pipelines on phone-width viewports"
```

---

### Task 4: Fluid composer/bubble widths, Home, Settings, and best-effort scroll for Pipelines/Code

**Files:**
- Modify: `web/style.css` (new media-query rules)

**Interfaces:** none — CSS-only.

- [ ] **Step 1: Add the remaining mobile CSS**

Append this as a new, self-contained block at the end of `web/style.css`:

```css
@media (max-width: 720px) {
  /* Fluid message bubbles (desktop uses fixed px max-widths) */
  .message,
  .message.user .bubble {
    max-width: 100%;
  }
  .msg-image-thumb { max-width: 45vw; max-height: 45vw; }

  /* Home */
  #home-main { padding: 4vh 14px 24px; }
  #home-greeting { font-size: 21px; }
  #home-compose-toolbar { flex-wrap: wrap; row-gap: 6px; }
  #home-agent-select, #home-model-select { max-width: 140px; }

  /* Chat composer */
  #composer-wrap { padding: 10px 10px 12px; }
  #composer-row { flex-wrap: wrap; row-gap: 6px; }

  /* Settings */
  #settings-main { padding: 20px 16px; }
  .settings-content { max-width: 100%; }

  /* Best-effort only: Pipelines canvas and the code editor's pane system
     keep their desktop CSS untouched — just make sure their containers
     scroll instead of clipping/overflowing the viewport. #code-pane-row-scroll
     is the code editor's real horizontal-scroll wrapper (web/index.html:413,
     wraps #code-pane-row where panes.js mounts each pane's .code-pane-body). */
  #pipe-canvas-wrap { overflow: auto; }
  #code-pane-row-scroll { overflow: auto; }
}
```

- [ ] **Step 2: Verify CSS parses**

```bash
cd /Volumes/library/projects/atlantis_os
python3 -c "
s = open('web/style.css').read()
assert s.count('{') == s.count('}')
print('balanced')
"
```

Expected: `balanced`.

- [ ] **Step 3: Manual walkthrough**

At a phone-width viewport:
1. Send a long chat message on both Home and Chat — confirm the bubble now uses most of the viewport width instead of clipping at a fixed desktop pixel width.
2. Confirm the Chat composer's buttons (attach/agent/model/send) wrap onto a second row instead of overflowing horizontally when all are present.
3. Open **Settings** — confirm the form is readable with sensible side padding, no horizontal scrollbar.
4. Open **Pipelines**, select a pipeline with a canvas wider than the viewport — confirm you can pan/scroll to see the whole canvas rather than it being clipped or the whole page gaining a horizontal scrollbar.
5. Open **Code** — confirm the pane area is scrollable rather than clipped when panes are wider than the viewport.

- [ ] **Step 4: Commit**

```bash
git add web/style.css
git commit -m "Fluid bubble/composer widths and best-effort scroll for Pipelines canvas and code editor panes on phone-width viewports"
```

---

### Task 5: Full regression pass + documentation

**Files:**
- Modify: `system_design.md` (Layout section)

**Interfaces:** none — documentation and end-to-end verification only.

- [ ] **Step 1: Document the change**

In `system_design.md`'s Layout section, add a short note describing the new `@media (max-width: 720px)` phone tier: hamburger overlay nav (closes on navigation), drill-down list/detail for Agents/Skills/Tasks/Plans (CSS `:has()`-driven, no per-section JS), overlay sidebar drawers for Chat/Models/Pipelines (shared `bindMobileSidebarToggle()`), fluid bubble/composer widths, and that the Pipelines canvas and code editor pane system are intentionally left desktop-shaped (scrollable, not reflowed).

- [ ] **Step 2: Full regression pass**

Run `python3 launcher.py` and, at desktop width first, click through every section to confirm nothing regressed (nav rail, all sidebars, chat, composer, settings all behave exactly as before this plan). Then narrow to phone width and walk through Tasks 1–4's manual-walkthrough steps in one continuous pass, including switching between sections repeatedly (e.g. Agents → Chat → Models → Pipelines → Settings → Home) to confirm no drawer/backdrop is left open incorrectly across a section switch (Task 1's `closeMobileNav()` only closes the *nav* drawer on switch — confirm this is acceptable, i.e. that leaving a section's own sidebar drawer open across a switch, if it happens, doesn't visually break the next section; if it does, note it in the completion summary rather than silently shipping it).

Fix anything that regressed; if no fixes were needed, skip the commit below.

- [ ] **Step 3: Commit**

```bash
git add system_design.md
git commit -m "Document the mobile phone layout tier in system_design.md"
```
