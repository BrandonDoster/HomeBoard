import os
import sqlite3
from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel
from typing import Optional, List
import uvicorn

PORT = int(os.environ.get("PORT", 8000))
DB_PATH = os.environ.get("DB_PATH", "/data/homeboard.db")

app = FastAPI(title="HomeBoard")


# ── Database helpers ────────────────────────────────────────────────────────

def get_db() -> sqlite3.Connection:
    db_dir = os.path.dirname(DB_PATH)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    conn = get_db()
    try:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT NOT NULL,
                created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS tasks (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                title       TEXT NOT NULL,
                due_date    TEXT,
                notes       TEXT,
                status      TEXT NOT NULL DEFAULT 'todo',
                position    INTEGER NOT NULL DEFAULT 0,
                created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS task_assignments (
                task_id  INTEGER NOT NULL,
                user_id  INTEGER NOT NULL,
                PRIMARY KEY (task_id, user_id),
                FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id)  ON DELETE CASCADE
            );
        """)
        # Seed default users on first run
        cur = conn.execute("SELECT COUNT(*) FROM users")
        if cur.fetchone()[0] == 0:
            conn.executemany(
                "INSERT INTO users (name) VALUES (?)",
                [("Mom",), ("Dad",), ("Kid",)]
            )
        conn.commit()
    finally:
        conn.close()


def row_to_task(row: sqlite3.Row, assigned_ids: List[int]) -> dict:
    return {
        "id":                row["id"],
        "title":             row["title"],
        "due_date":          row["due_date"],
        "notes":             row["notes"],
        "status":            row["status"],
        "position":          row["position"],
        "assigned_user_ids": assigned_ids,
    }


def fetch_task(conn: sqlite3.Connection, task_id: int) -> Optional[dict]:
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if not row:
        return None
    ids = [r["user_id"] for r in conn.execute(
        "SELECT user_id FROM task_assignments WHERE task_id = ?", (task_id,)
    ).fetchall()]
    return row_to_task(row, ids)


# ── Pydantic models ──────────────────────────────────────────────────────────

class UserCreate(BaseModel):
    name: str


class TaskCreate(BaseModel):
    title: str
    due_date: Optional[str] = None
    notes: Optional[str] = None
    status: str = "todo"
    position: int = 0
    assigned_user_ids: List[int] = []


class TaskUpdate(BaseModel):
    title: Optional[str] = None
    due_date: Optional[str] = None
    notes: Optional[str] = None
    status: Optional[str] = None
    position: Optional[int] = None
    assigned_user_ids: Optional[List[int]] = None


class TaskStatusUpdate(BaseModel):
    status: str


# ── User routes ──────────────────────────────────────────────────────────────

@app.get("/api/users")
def list_users():
    conn = get_db()
    try:
        rows = conn.execute("SELECT * FROM users ORDER BY id").fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@app.post("/api/users", status_code=201)
def create_user(body: UserCreate):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Name cannot be empty")
    conn = get_db()
    try:
        cur = conn.execute("INSERT INTO users (name) VALUES (?)", (name,))
        conn.commit()
        row = conn.execute("SELECT * FROM users WHERE id = ?", (cur.lastrowid,)).fetchone()
        return dict(row)
    finally:
        conn.close()


@app.delete("/api/users/{user_id}", status_code=204)
def delete_user(user_id: int):
    conn = get_db()
    try:
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
        conn.commit()
    finally:
        conn.close()


# ── Task routes ──────────────────────────────────────────────────────────────

@app.get("/api/tasks")
def list_tasks():
    conn = get_db()
    try:
        tasks = conn.execute(
            "SELECT * FROM tasks ORDER BY status, position, created_at"
        ).fetchall()
        result = []
        for t in tasks:
            ids = [r["user_id"] for r in conn.execute(
                "SELECT user_id FROM task_assignments WHERE task_id = ?", (t["id"],)
            ).fetchall()]
            result.append(row_to_task(t, ids))
        return result
    finally:
        conn.close()


@app.post("/api/tasks", status_code=201)
def create_task(body: TaskCreate):
    conn = get_db()
    try:
        cur = conn.execute(
            "INSERT INTO tasks (title, due_date, notes, status, position) VALUES (?,?,?,?,?)",
            (body.title.strip(), body.due_date, body.notes, body.status, body.position),
        )
        task_id = cur.lastrowid
        for uid in body.assigned_user_ids:
            conn.execute(
                "INSERT OR IGNORE INTO task_assignments (task_id, user_id) VALUES (?,?)",
                (task_id, uid),
            )
        conn.commit()
        return fetch_task(conn, task_id)
    finally:
        conn.close()


@app.put("/api/tasks/{task_id}")
def update_task(task_id: int, body: TaskUpdate):
    """Full update from the edit modal."""
    conn = get_db()
    try:
        if not conn.execute("SELECT id FROM tasks WHERE id = ?", (task_id,)).fetchone():
            raise HTTPException(404, "Task not found")

        # Build SET clause only for fields that were explicitly supplied
        supplied = body.model_fields_set
        updates: dict = {}
        if "title"    in supplied and body.title    is not None: updates["title"]    = body.title.strip()
        if "due_date" in supplied:                               updates["due_date"] = body.due_date
        if "notes"    in supplied:                               updates["notes"]    = body.notes
        if "status"   in supplied and body.status   is not None: updates["status"]   = body.status
        if "position" in supplied and body.position is not None: updates["position"] = body.position

        if updates:
            set_clause = ", ".join(f"{k} = ?" for k in updates)
            conn.execute(
                f"UPDATE tasks SET {set_clause} WHERE id = ?",
                (*updates.values(), task_id),
            )

        if "assigned_user_ids" in supplied and body.assigned_user_ids is not None:
            conn.execute("DELETE FROM task_assignments WHERE task_id = ?", (task_id,))
            for uid in body.assigned_user_ids:
                conn.execute(
                    "INSERT OR IGNORE INTO task_assignments (task_id, user_id) VALUES (?,?)",
                    (task_id, uid),
                )

        conn.commit()
        return fetch_task(conn, task_id)
    finally:
        conn.close()


@app.patch("/api/tasks/{task_id}/status")
def move_task(task_id: int, body: TaskStatusUpdate):
    """Lightweight status-only update used by drag-and-drop."""
    conn = get_db()
    try:
        if not conn.execute("SELECT id FROM tasks WHERE id = ?", (task_id,)).fetchone():
            raise HTTPException(404, "Task not found")
        conn.execute("UPDATE tasks SET status = ? WHERE id = ?", (body.status, task_id))
        conn.commit()
        return fetch_task(conn, task_id)
    finally:
        conn.close()


@app.delete("/api/tasks/{task_id}", status_code=204)
def delete_task(task_id: int):
    conn = get_db()
    try:
        conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
        conn.commit()
    finally:
        conn.close()


# ── Home Assistant integration routes ───────────────────────────────────────

@app.get("/api/ha/upcoming")
def ha_upcoming(days: int = 7):
    """
    Tasks due within `days` days that are not yet done.
    Includes resolved user names instead of raw IDs.
    Intended for HA REST sensors and template sensors.

    Query param:
        days  How many days ahead to look (default 7, use 0 for overdue only)

    Example:  GET /api/ha/upcoming?days=3
    """
    from datetime import date

    conn = get_db()
    try:
        user_map = {
            r["id"]: r["name"]
            for r in conn.execute("SELECT id, name FROM users").fetchall()
        }

        rows = conn.execute(
            """
            SELECT * FROM tasks
            WHERE status != 'done'
              AND due_date IS NOT NULL
              AND due_date <= date('now', '+' || ? || ' days')
            ORDER BY due_date ASC, title ASC
            """,
            (days,),
        ).fetchall()

        result = []
        for row in rows:
            assigned_ids = [
                r["user_id"] for r in conn.execute(
                    "SELECT user_id FROM task_assignments WHERE task_id = ?",
                    (row["id"],),
                ).fetchall()
            ]
            due = date.fromisoformat(row["due_date"])
            days_until = (due - date.today()).days

            result.append({
                "id":          row["id"],
                "title":       row["title"],
                "status":      row["status"],
                "due_date":    row["due_date"],
                "days_until":  days_until,
                "overdue":     days_until < 0,
                "notes":       row["notes"],
                "assigned_to": [user_map[uid] for uid in assigned_ids if uid in user_map],
            })

        return {
            "count": len(result),
            "days":  days,
            "tasks": result,
        }
    finally:
        conn.close()


@app.get("/api/ha/summary")
def ha_summary():
    """
    Count of tasks in each column plus overdue count.
    Intended for HA dashboard badges and binary sensors.

    Example:  GET /api/ha/summary
    """
    conn = get_db()
    try:
        counts = {
            r["status"]: r["cnt"]
            for r in conn.execute(
                "SELECT status, COUNT(*) AS cnt FROM tasks GROUP BY status"
            ).fetchall()
        }

        overdue = conn.execute(
            """
            SELECT COUNT(*) FROM tasks
            WHERE status != 'done'
              AND due_date IS NOT NULL
              AND due_date < date('now')
            """
        ).fetchone()[0]

        return {
            "todo":       counts.get("todo",       0),
            "inprogress": counts.get("inprogress", 0),
            "done":       counts.get("done",       0),
            "total":      sum(counts.values()),
            "overdue":    overdue,
        }
    finally:
        conn.close()


# ── Static files & SPA catch-all ────────────────────────────────────────────

app.mount("/static", StaticFiles(directory="static"), name="static")

def _serve_index(ingress_path: str = "") -> HTMLResponse:
    """
    Read index.html and inject a <base> tag pointing at the ingress path.

    When running behind HA ingress the Supervisor proxies requests through a
    path like /api/hassio_ingress/<TOKEN>/. Without a <base> tag the browser
    resolves relative URLs (static/style.css, api/tasks) against the HA root
    instead of the add-on root, so CSS/JS never load and every API call 404s.

    The base href must end with a trailing slash for relative paths to resolve
    correctly. Outside ingress (direct LAN access, local dev) ingress_path is
    empty and the base tag becomes <base href="/"> which is harmless.
    """
    with open("static/index.html", "r") as f:
        html = f.read()

    base_href = (ingress_path.rstrip("/") + "/") if ingress_path else "/"
    base_tag = f'<base href="{base_href}">'
    html = html.replace("</head>", f"  {base_tag}\n</head>", 1)
    return HTMLResponse(html)


@app.get("/")
def root(request: Request) -> HTMLResponse:
    ingress_path = request.headers.get("X-Ingress-Path", "")
    return _serve_index(ingress_path)


@app.get("/{path:path}")
def spa_fallback(path: str, request: Request) -> HTMLResponse:
    ingress_path = request.headers.get("X-Ingress-Path", "")
    return _serve_index(ingress_path)


# ── Entry point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    init_db()
    uvicorn.run(app, host="0.0.0.0", port=PORT)
