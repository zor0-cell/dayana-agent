// ============================================================
// Даяана — главный сервер
// ============================================================
require("dotenv").config();
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const { exec, execSync } = require("child_process");
const express = require("express");
const { WebSocketServer } = require("ws");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const Anthropic = require("@anthropic-ai/sdk");
const readline = require("readline");
const serviceAccount = require("./serviceAccountKey.json");

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();
const messaging = getMessaging();

// ---- AI-клиенты ----
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

// ---- Текущая модель (по умолчанию — Gemini) ----
let currentModel = "gemini"; // "gemini" | "claude"

// ---- Tools / function calling ----
const geminiTools = [
  {
    functionDeclarations: [
      {
        name: "open_program",
        description: "Открыть программу или приложение на ноуте пользователя",
        parameters: {
          type: "object",
          properties: {
            program: {
              type: "string",
              description: "Название программы для запуска",
            },
          },
          required: ["program"],
        },
      },
      {
        name: "set_reminder",
        description: "Установить напоминание или задачу на конкретную дату",
        parameters: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "Текст напоминания — что напомнить",
            },
            date: {
              type: "string",
              description: "Дата в формате YYYY-MM-DD (например, 2026-09-15)",
            },
            time: {
              type: "string",
              description: "Время в формате HH:MM (например, 10:00). Если не указано — используй 09:00",
            },
          },
          required: ["text", "date"],
        },
      },
      {
        name: "get_reminders",
        description: "Показать список предстоящих напоминаний и задач",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    ],
  },
];

const systemPromptOwner =
  "Ты — Даяана, умный личный ассистент. Общайся живо, по-человечески, понимай смысл, а не только команды. " +
  "Если пользователь просит открыть/запустить программу — используй функцию open_program. " +
  "Если просит напомнить что-то или добавить задачу в календарь — используй set_reminder (дату выведи из контекста, сегодня " + new Date().toISOString().slice(0, 10) + "). " +
  "Если просит показать напоминания или список задач — используй get_reminders.";

const geminiModel = genAI.getGenerativeModel({
  model: "gemini-2.0-flash",
  systemInstruction: systemPromptOwner,
  tools: geminiTools,
});

const guestGeminiModel = genAI.getGenerativeModel({
  model: "gemini-2.0-flash",
  systemInstruction:
    "Ты — Даяана. Общайся живо и дружелюбно. Ты разговариваешь с гостем — просто отвечай на вопросы, ничего не выполняй на компьютере.",
});

const guestHistories = new Map();

// ============================================================
// Напоминания
// ============================================================
async function setReminder(text, date, time = "09:00") {
  const [h, m] = time.split(":").map(Number);
  const triggerAt = new Date(`${date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`);
  await db.collection("reminders").add({
    text,
    triggerAt: Timestamp.fromDate(triggerAt),
    date,
    time,
    fired: false,
    createdAt: FieldValue.serverTimestamp(),
  });
  const formatted = triggerAt.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
  return `✅ Напоминание установлено на ${formatted} в ${time}: «${text}»`;
}

async function getReminders() {
  const now = new Date();
  const snap = await db
    .collection("reminders")
    .where("fired", "==", false)
    .where("triggerAt", ">=", Timestamp.fromDate(now))
    .orderBy("triggerAt")
    .limit(10)
    .get();

  if (snap.empty) return "📭 Нет предстоящих напоминаний.";

  const lines = snap.docs.map((doc) => {
    const d = doc.data();
    const dt = d.triggerAt.toDate();
    const formatted = dt.toLocaleDateString("ru-RU", { day: "numeric", month: "long" }) + " в " + d.time;
    return `• ${formatted}: ${d.text}`;
  });
  return "📅 Предстоящие напоминания:\n" + lines.join("\n");
}

// Проверка напоминаний каждую минуту
async function checkReminders() {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + 60000); // +1 минута

  const snap = await db
    .collection("reminders")
    .where("fired", "==", false)
    .where("triggerAt", "<=", Timestamp.fromDate(windowEnd))
    .get();

  for (const doc of snap.docs) {
    const data = doc.data();
    const msg = `🔔 Напоминание: ${data.text}`;

    // Отправить в чат
    await db.collection("messages").add({
      role: "assistant",
      mode: "owner",
      text: msg,
      createdAt: FieldValue.serverTimestamp(),
    });

    // Отправить push на телефон
    await sendPushToAll(msg);

    // Пометить как выполнено
    await doc.ref.update({ fired: true, firedAt: FieldValue.serverTimestamp() });
    console.log("Напоминание отправлено:", data.text);
  }
}

setInterval(checkReminders, 60000);

// ============================================================
// Push-уведомления (Web Push через FCM)
// ============================================================
async function sendPushToAll(body, title = "Даяана") {
  try {
    const tokensSnap = await db.collection("fcmTokens").get();
    if (tokensSnap.empty) return;

    const tokens = tokensSnap.docs.map((d) => d.data().token).filter(Boolean);
    if (!tokens.length) return;

    const message = {
      notification: { title, body },
      tokens,
      webpush: {
        notification: {
          title,
          body,
          icon: "/icon.png",
          badge: "/icon.png",
        },
      },
    };

    const response = await messaging.sendEachForMulticast(message);
    console.log(`Push отправлен: ${response.successCount} успешно, ${response.failureCount} ошибок`);

    // Удалить невалидные токены
    response.responses.forEach((res, i) => {
      if (!res.success) {
        console.warn("Невалидный FCM токен:", tokens[i]);
        db.collection("fcmTokens").where("token", "==", tokens[i]).get()
          .then(snap => snap.forEach(d => d.ref.delete()));
      }
    });
  } catch (err) {
    console.error("Ошибка отправки push:", err.message);
  }
}

// ============================================================
// Запуск программ
// ============================================================
console.log("Даяана-агент запущен. Слушаю...");

function heartbeat() {
  db.collection("status")
    .doc("laptop")
    .set({ online: true, lastSeen: FieldValue.serverTimestamp() })
    .catch((err) => console.error("Ошибка маячка:", err.message));
}
heartbeat();
setInterval(heartbeat, 20000);

let programIndex = {};

function loadInstalledPrograms() {
  try {
    const output = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${__dirname}\\scan.ps1"`,
      { maxBuffer: 1024 * 1024 * 10 }
    ).toString();
    let list = JSON.parse(output);
    if (!Array.isArray(list)) list = [list];
    programIndex = {};
    list.forEach((item) => {
      if (item && item.Name && item.Target) {
        programIndex[item.Name.toLowerCase()] = item.Target;
      }
    });
    console.log(`Найдено программ: ${Object.keys(programIndex).length}`);
  } catch (err) {
    console.error("Ошибка сканирования программ:", err.message);
  }
}

loadInstalledPrograms();
setInterval(loadInstalledPrograms, 60 * 60 * 1000);

const builtinCommands = {
  хром: "start chrome",
  chrome: "start chrome",
  браузер: "start chrome",
  блокнот: "notepad",
  notepad: "notepad",
  "яндекс музыка": "start yandexmusic:",
  музыка: "start yandexmusic:",
  ворд: "start winword",
  word: "start winword",
  эксель: "start excel",
  excel: "start excel",
  калькулятор: "calc",
  проводник: "explorer",
};

const nameAliases = {
  телеграм: "telegram",
  телега: "telegram",
  "гугл хром": "google chrome",
  гугл: "google chrome",
  дискорд: "discord",
  стим: "steam",
  спотифай: "spotify",
  гитхаб: "github desktop",
  "вс код": "visual studio code",
  "студио код": "visual studio code",
};

function findInIndex(name) {
  const key = name.toLowerCase().trim();
  const searchKey = nameAliases[key] || key;
  if (programIndex[searchKey]) return programIndex[searchKey];
  const foundKey = Object.keys(programIndex).find(
    (k) => k.includes(searchKey) || searchKey.includes(k)
  );
  return foundKey ? programIndex[foundKey] : null;
}

function openProgram(name) {
  const key = (name || "").toLowerCase().trim();
  let cmd = builtinCommands[key];
  if (!cmd) {
    const foundKey = Object.keys(builtinCommands).find(
      (k) => key.includes(k) || k.includes(key)
    );
    cmd = foundKey ? builtinCommands[foundKey] : null;
  }
  if (!cmd) {
    const target = findInIndex(key);
    if (target) cmd = `"${target}"`;
  }
  if (!cmd) cmd = `start ${name}`;
  exec(cmd, (err) => {
    if (err) console.error("Ошибка запуска:", err.message);
  });
  return `Открываю: ${name}`;
}

// ============================================================
// Мозг — Gemini
// ============================================================
const chatHistory = [];

async function askGeminiBrain(userText) {
  chatHistory.push({ role: "user", parts: [{ text: userText }] });

  const openMatch = userText.toLowerCase().match(/(?:открой|запусти|включи)\s+(.+)/);
  if (openMatch) {
    const res = openProgram(openMatch[1].trim());
    chatHistory.push({ role: "model", parts: [{ text: res }] });
    return res;
  }

  const chat = geminiModel.startChat({ history: chatHistory.slice(0, -1) });
  let result = await chat.sendMessage(userText);
  let response = result.response;

  const calls = response.functionCalls();
  if (calls && calls.length > 0) {
    const call = calls[0];
    let funcResult = "Неизвестное действие";

    if (call.name === "open_program") {
      funcResult = openProgram(call.args.program);
    } else if (call.name === "set_reminder") {
      funcResult = await setReminder(call.args.text, call.args.date, call.args.time);
    } else if (call.name === "get_reminders") {
      funcResult = await getReminders();
    }

    result = await chat.sendMessage([
      { functionResponse: { name: call.name, response: { result: funcResult } } },
    ]);
    response = result.response;
  }

  const reply = response.text();
  chatHistory.push({ role: "model", parts: [{ text: reply }] });
  return reply;
}

// ============================================================
// Мозг — Claude
// ============================================================
const claudeHistory = [];

async function askClaudeBrain(userText) {
  claudeHistory.push({ role: "user", content: userText });

  const claudeTools = [
    {
      name: "open_program",
      description: "Открыть программу или приложение на ноуте пользователя",
      input_schema: {
        type: "object",
        properties: {
          program: { type: "string", description: "Название программы" },
        },
        required: ["program"],
      },
    },
    {
      name: "set_reminder",
      description: "Установить напоминание на конкретную дату",
      input_schema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Текст напоминания" },
          date: { type: "string", description: "Дата в формате YYYY-MM-DD" },
          time: { type: "string", description: "Время в формате HH:MM" },
        },
        required: ["text", "date"],
      },
    },
    {
      name: "get_reminders",
      description: "Показать список предстоящих напоминаний",
      input_schema: { type: "object", properties: {} },
    },
  ];

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    system:
      "Ты — Даяана, умный личный ассистент. Общайся живо, по-человечески. " +
      "Используй инструменты для открытия программ и управления напоминаниями. " +
      "Сегодня: " + new Date().toISOString().slice(0, 10),
    messages: claudeHistory,
    tools: claudeTools,
  });

  // Обработка tool_use от Claude
  if (response.stop_reason === "tool_use") {
    const toolUseBlock = response.content.find((b) => b.type === "tool_use");
    if (toolUseBlock) {
      let toolResult = "Неизвестное действие";
      if (toolUseBlock.name === "open_program") {
        toolResult = openProgram(toolUseBlock.input.program);
      } else if (toolUseBlock.name === "set_reminder") {
        toolResult = await setReminder(
          toolUseBlock.input.text,
          toolUseBlock.input.date,
          toolUseBlock.input.time
        );
      } else if (toolUseBlock.name === "get_reminders") {
        toolResult = await getReminders();
      }

      claudeHistory.push({ role: "assistant", content: response.content });
      claudeHistory.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseBlock.id,
            content: toolResult,
          },
        ],
      });

      const followUp = await anthropic.messages.create({
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        system:
          "Ты — Даяана, умный личный ассистент. Общайся живо, по-человечески. Сегодня: " +
          new Date().toISOString().slice(0, 10),
        messages: claudeHistory,
        tools: claudeTools,
      });

      const reply = followUp.content.find((b) => b.type === "text")?.text || "";
      claudeHistory.push({ role: "assistant", content: reply });
      return reply;
    }
  }

  const reply = response.content.find((b) => b.type === "text")?.text || "";
  claudeHistory.push({ role: "assistant", content: reply });
  return reply;
}

// ============================================================
// Гостевой мозг
// ============================================================
async function askGuestBrain(uid, userText) {
  if (!guestHistories.has(uid)) guestHistories.set(uid, []);
  const history = guestHistories.get(uid);
  const chat = guestGeminiModel.startChat({ history });
  const result = await chat.sendMessage(userText);
  const reply = result.response.text();
  history.push({ role: "user", parts: [{ text: userText }] });
  history.push({ role: "model", parts: [{ text: reply }] });
  return reply;
}

// ============================================================
// Универсальная точка входа — выбор модели
// ============================================================
async function askBrain(userText) {
  // Команда переключения модели
  const lower = userText.toLowerCase().trim();
  if (lower.includes("переключись на claude") || lower.includes("используй claude") || lower === "claude") {
    currentModel = "claude";
    return "🤖 Переключилась на Claude. Готова!";
  }
  if (lower.includes("переключись на gemini") || lower.includes("используй gemini") || lower === "gemini") {
    currentModel = "gemini";
    return "🤖 Переключилась на Gemini. Готова!";
  }
  if (lower === "какая модель" || lower === "какой мозг") {
    return `🧠 Сейчас использую: ${currentModel === "claude" ? "Claude (Anthropic)" : "Gemini (Google)"}`;
  }

  if (currentModel === "claude") {
    return await askClaudeBrain(userText);
  } else {
    return await askGeminiBrain(userText);
  }
}

// ============================================================
// Firebase слушатели
// ============================================================

// Команды (открыть программу напрямую)
db.collection("commands")
  .where("status", "==", "pending")
  .onSnapshot((snapshot) => {
    snapshot.docChanges().forEach(async (change) => {
      if (change.type !== "added") return;
      const doc = change.doc;
      const data = doc.data();
      const result = openProgram(data.text || "");
      await doc.ref.update({ status: "done", result, completedAt: FieldValue.serverTimestamp() });
    });
  });

// Сообщения владельца
db.collection("messages")
  .where("role", "==", "user")
  .onSnapshot((snapshot) => {
    snapshot.docChanges().forEach(async (change) => {
      if (change.type !== "added") return;
      const doc = change.doc;
      const data = doc.data();
      if (data.handled) return;
      await doc.ref.update({ handled: true });
      const reply = await askBrain(data.text || "");
      await db.collection("messages").add({
        role: "assistant",
        mode: data.mode || "owner",
        text: reply,
        createdAt: FieldValue.serverTimestamp(),
      });
    });
  });

// Гостевые сообщения
db.collection("guestMessages")
  .where("role", "==", "user")
  .onSnapshot((snapshot) => {
    snapshot.docChanges().forEach(async (change) => {
      if (change.type !== "added") return;
      const doc = change.doc;
      const data = doc.data();
      if (data.handled) return;
      await doc.ref.update({ handled: true });
      const reply = await askGuestBrain(data.uid, data.text || "");
      await db.collection("guestMessages").add({
        uid: data.uid,
        role: "assistant",
        text: reply,
        createdAt: FieldValue.serverTimestamp(),
      });
    });
  });

// Переключение модели через Firestore (с телефона)
db.collection("settings")
  .doc("model")
  .onSnapshot((snap) => {
    if (snap.exists) {
      const data = snap.data();
      if (data.active && (data.active === "gemini" || data.active === "claude")) {
        currentModel = data.active;
        console.log("Модель переключена на:", currentModel);
      }
    }
  });

// ============================================================
// HTTP + WebSocket сервер
// ============================================================
const app = express();
app.use(express.static("public"));
app.listen(3000, () => console.log("Чат доступен на http://localhost:3000"));

const wss = new WebSocketServer({ port: 3001 });
wss.on("connection", (ws) => {
  ws.on("message", async (msg) => {
    const text = msg.toString();
    const reply = await askBrain(text);
    ws.send(reply);
  });
});

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", () => {
  exec("start http://localhost:3000");
});