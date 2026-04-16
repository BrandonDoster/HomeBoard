# HomeBoard — Project Context & Decision Log

This document captures the reasoning behind every significant architectural, technology, and code decision in the initial build. It exists so that future iterations — whether adding tabs, changing the data model, or deploying to new infrastructure — start with full context rather than having to reverse-engineer intent from the code.

---

## Project Summary

HomeBoard is a self-hosted household management web app. The initial scope is a Kanban board with drag-and-drop task management. The architecture is intentionally minimal: a single Python process, a local SQLite file, and static HTML/CSS/JS served from the same process. No build pipeline, no Node.js, no ORM.

---

## Technology Stack Decisions

### Python + FastAPI

Python was chosen as the lightest credible option for a small REST + static file server given the household deployment target (a home server, NAS, or similar low-powered device). FastAPI specifically was selected over Flask for two reasons:

1. **Pydantic validation is built-in.** Request body parsing and type coercion happen automatically without extra boilerplate. This matters for the `PUT /tasks/{id}` partial-update logic where `model_fields_set` is used to distinguish "field not sent" from "field explicitly set to null" — Flask would require writing that detection manually.
2. **ASGI / uvicorn** gives better connection handling under concurrent requests with no extra configuration, even though load is low in this context.

Flask would have been equally valid. The deciding factor was the `model_fields_set` Pydantic feature, which solved a real problem cleanly (see the Two-Endpoint Strategy section below).

### SQLite via stdlib `sqlite3`

No ORM (SQLAlchemy, Tortoise, etc.) was used. For three tables and simple CRUD, an ORM adds more surface area than it removes. The queries are short enough to be immediately readable, and the schema is defined explicitly in `init_db()` so there is no migration framework to manage.

The database file lives at `DB_PATH` (default `/data/homeboard.db`) so that a Docker named volume can be mounted at `/data`. This means the SQLite file survives container rebuilds and redeployments without any additional tooling.

`PRAGMA foreign_keys = ON` is set on every connection. SQLite does not enforce foreign key constraints by default; without this pragma, deleting a user would leave orphaned rows in `task_assignments` silently. CASCADE deletes on that table depend on it.

### Vanilla JavaScript (no framework)

React, Vue, and similar frameworks were explicitly not used. The application's interactivity surface is small: render a list, open a modal, drag a card. A framework would require a build step, a `node_modules` directory, and ongoing dependency management for no functional gain. The frontend is three files: `index.html`, `style.css`, `app.js`. They are served directly by FastAPI's `StaticFiles` mount. There is nothing to compile.

The state model is a simple module-level object (`state = { tasks, users, editTaskId, dragTaskId }`). Mutations go through functions that then call `renderBoard()` or `renderSettings()`. This is intentional — it is the minimal viable reactive pattern without a framework.

### No UV, No Virtual Environments

The container build uses `pip install --no-cache-dir -r requirements.txt` directly. UV is a developer-experience tool; it adds no value inside a Docker image where the environment is already isolated and the install happens exactly once at build time. Using plain pip keeps the Dockerfile understandable to anyone without UV familiarity and avoids a potential point of confusion.

---

## Database Schema Decisions

### Three Tables: `users`, `tasks`, `task_assignments`

**`users`** is its own table rather than a hardcoded set of checkbox labels for two reasons:

1. The Settings tab lets the household edit names without touching code or config.
2. The table is available for reuse by future tabs (shopping list, chores, calendar, etc.) without any schema migration — they all reference the same people.

Default seed data (Mom, Dad, Kid) is inserted only if the table is empty on first startup. This means the defaults apply to a fresh install but are never re-inserted if a user deletes or renames them.

**`task_assignments`** is a join table with `(task_id, user_id)` as a composite primary key. This allows a task to be assigned to multiple users simultaneously. The alternative — storing a comma-separated list of user IDs in a `tasks` column — would break filtering and make user deletion messy. The join table approach means deleting a user automatically cleans up their assignments via `ON DELETE CASCADE` (requires the `PRAGMA foreign_keys = ON` mentioned above).

**`tasks.position`** is present in the schema but not currently used by the UI. It is a placeholder for within-column card ordering. When drag-and-drop reordering within a column is added in a future iteration, the column is already there. Current ordering is by `(status, position, created_at)` — so cards appear in insertion order until manual reordering is implemented.

### `created_at` on All Tables

Both `users` and `tasks` carry `created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`. This costs nothing and has repeatedly proven useful in practice for debugging and for ordering queries when explicit position data is absent. It is not exposed in the UI currently.

---

## API Design Decisions

### Two Separate Update Endpoints for Tasks

There are two endpoints that modify a task:

- `PATCH /api/tasks/{id}/status` — accepts only `{ "status": "inprogress" }`, used by drag-and-drop
- `PUT /api/tasks/{id}` — accepts the full task body, used by the modal save button

This separation exists to solve a concrete problem: how do you distinguish "user didn't send `due_date`" from "user explicitly cleared `due_date` to null"? If both cases arrive as `null` in a single generic update endpoint, you cannot tell them apart without extra payload complexity.

The solution used in `PUT` is Pydantic's `model_fields_set`: only fields that were actually present in the JSON body appear in this set. So a drag-and-drop sending `{ "status": "inprogress" }` would have `model_fields_set == {"status"}`, and the handler would not touch `due_date` or `notes`. But this creates a hazard — if the frontend for drag-and-drop accidentally hits the full `PUT` endpoint instead of `PATCH`, it would clear all other fields. The two-endpoint separation makes this mistake impossible at the routing level.

For future tabs, adopt the same pattern: a lightweight `PATCH /{resource}/{id}/{field}` for single-field toggles and a full `PUT /{resource}/{id}` for modal-style edits.

### No Authentication / No Sessions

Deliberately omitted. This is a LAN-only household app behind a home router. Adding auth would require session storage, password hashing, and a login UI with no meaningful security benefit in that context. If this is ever exposed beyond the LAN (via a reverse proxy, Tailscale, etc.), add HTTP basic auth at the reverse proxy layer rather than in the application.

### `/api/` Prefix for All Backend Routes

All API routes are under `/api/`. Static files are served under `/static/`. The root `/` returns `index.html`, and a catch-all `/{path:path}` also returns `index.html` for SPA compatibility. This clean separation means a reverse proxy can route `/api/*` to the backend and cache `/static/*` independently if needed in the future.

---

## Frontend Architecture Decisions

### Optimistic UI Updates for Drag-and-Drop

When a card is dragged to a new column, the UI updates immediately (the card visually moves) and the `PATCH` request fires asynchronously in the background. If the request fails, `loadAll()` is called to re-sync state from the server, which reverts the card to its true position. This makes the drag feel instant over a local network connection. The failure path (revert) handles network errors and server errors equally.

For modal saves, the update is not optimistic — the modal stays open until the server confirms success. This is intentional because validation errors from the server (e.g., empty title) should surface to the user before the modal closes.

### Avatar Color Assignment

Avatars use a fixed palette of 7 colors assigned by index position in the `state.users` array. This is not stable across user deletions — if "Mom" (index 0, blue) is deleted, "Dad" shifts to index 0 and becomes blue. This was an accepted tradeoff for simplicity. If stable color assignment matters, add a `color` column to the `users` table and let the Settings UI assign it, or derive the color from a hash of the user's name.

### Modal Uses `aria-hidden` Rather Than CSS `.hidden`

The modal overlay uses `aria-hidden="true"/"false"` toggled by JS rather than a CSS class toggle. This was chosen because it serves dual purpose: accessibility (screen readers respect `aria-hidden`) and CSS (`[aria-hidden="true"] { display: none }` is in the stylesheet). Single attribute, two effects.

### Escape Key and Ctrl+Enter in the Modal

`Escape` closes the modal without saving. `Ctrl+Enter` (or `Cmd+Enter` on Mac) saves and closes. These are established conventions for modal dialogs. The keyboard handlers are attached to `document` and gated on the overlay's `aria-hidden` state so they only fire when the modal is actually open.

---

## Docker / Deployment Decisions

### `PORT` and `DB_PATH` as Environment Variables

Both are configurable at runtime so the container can be deployed without rebuilding:

- `PORT` defaults to `8000`. Change it if the port conflicts with another service or if running behind a reverse proxy that expects a specific backend port.
- `DB_PATH` defaults to `/data/homeboard.db`. The `/data` path corresponds to the named volume in `docker-compose.yml`. Change it if you prefer a bind mount to a specific host path.

### Named Volume for SQLite

`docker-compose.yml` uses a named volume (`homeboard_data`) rather than a bind mount. Named volumes are managed by Docker and persist across `docker compose down` and `docker compose up` without the user needing to know or specify a host filesystem path. If you prefer to know exactly where the file lives on the host (for manual backup, for instance), replace:

```yaml
volumes:
  - homeboard_data:/data
```

with:

```yaml
volumes:
  - /your/chosen/host/path:/data
```

### Non-Root User in Container

The Dockerfile creates a system user `app` and switches to it before starting the process. This is a container security baseline — the process should not run as root even if the container is compromised. The `/data` directory is `chown`ed to `app` at build time so the process can write to it.

### `python main.py` Startup (Not `uvicorn` Directly)

The container entrypoint is `python main.py` rather than `uvicorn main:app --host 0.0.0.0 --port ...`. This is because `main.py` calls `init_db()` before starting uvicorn. Calling uvicorn directly would bypass `init_db()`, meaning the database tables and seed data would never be created on a fresh volume. If the startup command is ever changed to call uvicorn directly, `init_db()` must be triggered another way (a separate entrypoint script, a FastAPI `lifespan` handler, etc.).

---

## Home Assistant Integration Endpoints

### Why Dedicated `/api/ha/*` Routes Instead of Reusing `/api/tasks`

`GET /api/tasks` returns the raw internal representation — user IDs instead of names, no computed fields, no filtering. Home Assistant's REST sensor can only apply a single `value_template` expression to shape the response. Making HA do the filtering and name resolution inside Jinja2 templates would be brittle and hard to maintain. The HA endpoints do that work server-side and return a clean, flat shape that HA can consume without transformation.

The `/api/ha/` prefix keeps them clearly separated from the app's internal CRUD API. If authentication is ever added to the main API, the HA endpoints can be treated differently (e.g., a separate read-only API key) without touching the internal routes.

### `days_until` and `overdue` as Computed Fields

Both are derived from `due_date` and today's date at query time rather than stored in the database. Storing them would require either a background job to keep them current or recalculating on every write. Computing them at read time is correct and cheap. `days_until` can be negative (overdue), zero (due today), or positive (upcoming). HA automations can filter on any of these with a simple `selectattr` expression.

### `assigned_to` Returns Names, Not IDs

The HA endpoints resolve user IDs to names in the query handler. This means HA automations and Lovelace templates can use `t.assigned_to` directly in notification messages without a second lookup. The tradeoff is that renaming a user in Settings will be reflected immediately in future HA sensor polls without any HA config change.

### `scan_interval: 300` in the README Examples

Five minutes was chosen as the suggested poll interval. The board is household-scale and tasks don't change by the second. Polling more frequently wastes resources; polling less frequently means a task added on the board might not appear in HA for a while. Adjust to taste — `60` seconds is fine for a home server with low load.



### Within-Column Card Ordering

The `tasks.position` column exists but is not surfaced. Drag-and-drop currently only moves cards between columns, not within a column. Implementing within-column ordering requires tracking the target card's position in the DOM, sending `position` values back to the server, and re-sorting the `renderBoard()` output. The schema is ready; the logic is not.

### Shopping List Tab

The Shopping tab renders a placeholder. The intended schema for a future iteration:

```sql
CREATE TABLE shopping_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    quantity    TEXT,
    done        INTEGER NOT NULL DEFAULT 0,
    added_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

The `added_by` foreign key references the existing `users` table directly. No schema change to `users` is needed to add this.

### Additional Tabs

The tab nav in `index.html` is generic. Adding a new tab requires:

1. A `<button class="tab-btn" data-tab="newtab">` in the nav — the JS `initTabs()` function handles it automatically via `data-tab`.
2. A `<section id="tab-newtab" class="tab-pane">` in the body.
3. New table(s) in `init_db()` in `main.py`.
4. New routes under `/api/newtab/...` in `main.py`.
5. Render and data functions in `app.js`.

No changes to the tab switching logic, CSS, or routing are needed for new tabs.

### Task Labels / Categories

No label or tag system was built. If added, the recommended approach is a `labels` table and a `task_labels` join table (mirroring the `task_assignments` pattern), rather than a free-text column, so labels can be filtered and managed consistently.

### Search / Filter

No search or column filter was built. The board is expected to stay small enough (household scale) that visual scanning is sufficient. If added, implement it as a client-side filter over `state.tasks` — no server round-trip needed.

---

## Known Limitations

- **SQLite write concurrency:** SQLite handles one write at a time. For a single-household app this is not a problem. If the app ever needs to support higher concurrency, migrate to PostgreSQL and add SQLAlchemy or an async driver.
- **No input sanitization beyond Pydantic:** The backend trusts that `title`, `notes`, etc. are strings. XSS protection on the frontend is handled by `escHtml()` in `app.js` which uses `textContent` assignment. Do not bypass `escHtml()` when rendering user-supplied strings.
- **No error UI:** API failures log to the browser console but show nothing to the user. A future iteration should add a minimal toast/banner for save and delete failures.
- **Avatar color drift on user deletion:** Described above in the Frontend section.
- **Date input locale:** `<input type="date">` renders in the browser's locale format in the UI but stores and transmits in `YYYY-MM-DD` (ISO 8601) format. This is correct behavior but may look unexpected in non-US browser locales.

---

## Home Assistant Add-on Packaging

### Repository Structure

HA requires a specific repository layout to discover add-ons. The GitHub repo root must contain a `README.md` (shown on the "Add repository" screen in HA), and each add-on lives in its own subdirectory containing at minimum `config.yaml` and `Dockerfile`. Multiple add-ons can live in one repo — this is how community repos like the official add-on store work.

```
homeboard-addon/          ← GitHub repo root
├── README.md             ← shown when user adds the repo in HA
└── homeboard/            ← one folder per add-on (slug must match config.yaml slug)
    ├── config.yaml       ← add-on manifest
    ├── Dockerfile        ← uses ARG BUILD_FROM (HA convention)
    ├── run.sh            ← entrypoint script
    ├── main.py
    ├── requirements.txt
    └── static/
```

### `ARG BUILD_FROM` in the Dockerfile

The standalone Dockerfile uses `FROM python:3.12-slim`. The add-on Dockerfile uses `ARG BUILD_FROM` / `FROM ${BUILD_FROM}` instead. The HA Supervisor injects a per-architecture base image at build time — for example `ghcr.io/home-assistant/amd64-base-python:3.12` on x86-64 or `ghcr.io/home-assistant/aarch64-base-python:3.12` on Raspberry Pi. This is how the same Dockerfile builds correctly across all the architectures listed in `config.yaml` without any conditional logic.

The `arch` list in `config.yaml` declares which architectures the Supervisor should build for. All five current HA architectures are listed: `amd64`, `aarch64` (RPi 4/5), `armv7` (RPi 3), `armhf`, and `i386`.

### Non-Root vs Root

The standalone container creates a non-root `app` user. The add-on container does not — it runs as root. HA add-on containers run as root by convention; isolation is managed by the Supervisor and the underlying Docker daemon, not by the container user. Creating a non-root user inside an add-on container adds no security benefit in the HA context and can cause permission issues with the `/data` volume mount that the Supervisor manages.

### Ingress vs Direct Port Mapping

`config.yaml` uses `ingress: true` rather than a `ports` mapping. Ingress means the Supervisor reverse-proxies the add-on's web UI through HA's own HTTPS endpoint — the user never needs to open a port, configure a firewall rule, or deal with HTTP vs HTTPS. The sidebar entry and "Open Web UI" button are provided automatically when ingress is enabled. `panel_icon` and `panel_title` control how the sidebar entry appears.

Direct port mapping (`ports: { "8000/tcp": 8000 }`) is the alternative — it exposes the add-on on a LAN port directly, like the standalone Docker container does. The reason ingress is preferred: it works transparently whether the user is on the LAN or accessing HA remotely via Nabu Casa, and it doesn't require the user to know or remember a port number.

### `/data` Persistence

The `map: [data]` entry in `config.yaml` tells the Supervisor to mount a persistent volume at `/data` inside the container. This volume is tied to the add-on slug (`homeboard`) and survives add-on updates, reinstalls, and HA restarts. The SQLite file at `/data/homeboard.db` therefore persists across the full lifecycle of the add-on. If the user uninstalls the add-on and reinstalls it, the data is still there unless they explicitly delete it via the Supervisor storage management UI.

### `run.sh` and `bashio`

HA add-on containers use `/usr/bin/with-contenv bashio` as the script interpreter rather than plain bash. `bashio` is the Supervisor's shell helper library — it provides `bashio::log.info` (writes to the HA add-on log panel), `bashio::config` (reads options from `config.yaml` schema), and other helpers. The shebang `#!/usr/bin/with-contenv bashio` also loads Supervisor-injected environment variables into the shell environment before the script runs, which is how `PORT` arrives without being explicitly set.

### Watchdog

`watchdog: http://[HOST]:[PORT:8000]/api/ha/summary` tells the Supervisor to poll that endpoint periodically. If it stops responding, the Supervisor automatically restarts the add-on. The `/api/ha/summary` endpoint was chosen because it is lightweight (a single SQLite COUNT query), always returns JSON, and exercises the full app stack including the database connection.

### Updating the Add-on

To ship an update: bump `version` in `config.yaml`, push to GitHub. Users with the repo added will see an update badge in the add-on store. The Supervisor rebuilds the image from the new Dockerfile, stops the old container, starts the new one, and the `/data` volume is remounted — data is fully preserved.
