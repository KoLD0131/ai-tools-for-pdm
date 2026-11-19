const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const PORT = Number(process.env.PORT) || 3000;
const SLOT_TIMES = ["09:00", "11:00", "13:00", "15:00", "17:00"];
const db = new DatabaseSync(path.join(__dirname, "boris.sqlite"));

db.exec(`
  CREATE TABLE IF NOT EXISTS walk_slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    walk_date TEXT NOT NULL,
    slot_time TEXT NOT NULL,
    booked_by TEXT,
    booked_at TEXT,
    UNIQUE (walk_date, slot_time),
    CHECK (
      (booked_by IS NULL AND booked_at IS NULL)
      OR
      (booked_by IS NOT NULL AND booked_at IS NOT NULL)
    )
  );

  CREATE TABLE IF NOT EXISTS feedings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_name TEXT NOT NULL,
    fed_at TEXT NOT NULL
  );
`);

function moscowToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function dateLabel() {
  const label = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date());
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function cleanName(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ");
}

function ensureSlots(date) {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO walk_slots (walk_date, slot_time) VALUES (?, ?)"
  );
  for (const time of SLOT_TIMES) insert.run(date, time);
}

function readState() {
  const date = moscowToday();
  ensureSlots(date);
  const slots = db.prepare(
    "SELECT slot_time, booked_by FROM walk_slots WHERE walk_date = ? ORDER BY slot_time"
  ).all(date);
  const feeding = db.prepare(
    "SELECT employee_name, fed_at FROM feedings ORDER BY id DESC LIMIT 1"
  ).get();
  return {
    date,
    dateLabel: dateLabel(),
    slots: slots.map((row) => ({ time: row.slot_time, bookedBy: row.booked_by })),
    feeding: feeding
      ? { employeeName: feeding.employee_name, fedAt: feeding.fed_at }
      : null,
  };
}

function bookSlot(slotTime, name) {
  if (!SLOT_TIMES.includes(slotTime)) {
    return { status: 400, body: { error: "Неизвестный слот." } };
  }
  const clean = cleanName(name);
  if (!clean) {
    return { status: 400, body: { error: "Введите ФИО." } };
  }
  const date = moscowToday();
  ensureSlots(date);
  const result = db.prepare(
    `UPDATE walk_slots
     SET booked_by = ?, booked_at = ?
     WHERE walk_date = ? AND slot_time = ? AND booked_by IS NULL`
  ).run(clean, new Date().toISOString(), date, slotTime);
  if (result.changes === 1) {
    return { status: 200, body: readState() };
  }
  const current = db.prepare(
    "SELECT booked_by FROM walk_slots WHERE walk_date = ? AND slot_time = ?"
  ).get(date, slotTime);
  return {
    status: 409,
    body: {
      error: `Этот слот уже занят. Записан(а): ${current.booked_by}.`,
      state: readState(),
    },
  };
}

function addFeeding(name) {
  const clean = cleanName(name);
  if (!clean) {
    return { status: 400, body: { error: "Введите ФИО." } };
  }
  db.prepare("INSERT INTO feedings (employee_name, fed_at) VALUES (?, ?)").run(
    clean,
    new Date().toISOString()
  );
  return { status: 200, body: readState() };
}

function send(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 100000) {
        reject(Object.assign(new Error("Слишком большой запрос."), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("Некорректный запрос."), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = fs.readFileSync(path.join(__dirname, "index.html"));
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(html);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      send(res, 200, readState());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/bookings") {
      const body = await readBody(req);
      const result = bookSlot(body.slotTime, body.name);
      send(res, result.status, result.body);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/feedings") {
      const body = await readBody(req);
      const result = addFeeding(body.name);
      send(res, result.status, result.body);
      return;
    }
    send(res, 404, { error: "Не найдено." });
  } catch (error) {
    send(res, error.status || 500, { error: error.status ? error.message : "Ошибка сервера." });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Борис слушает http://127.0.0.1:${PORT}`);
});
