require("dotenv").config();
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { exec, execSync } = require("child_process");
const express = require("express");
const { WebSocketServer } = require("ws");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const readline = require("readline");
const serviceAccount = require("./serviceAccountKey.json");

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const tools = [
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
              description: "Название программы для запуска, например: chrome, блокнот, яндекс музыка, ворд, калькулятор, эксель, телеграм",
            },
          },
          required: ["program"],
        },
      },
    ],
  },
];

const model = genAI.getGenerativeModel({
  model: "gemini-3.6-flash",
  systemInstruction: "Ты — Даяана, умный личный ассистент. Общайся живо, по-человечески, понимай смысл, а не только команды. Если пользователь просит открыть/запустить программу на ноуте — используй функцию open_program вместо простого текстового ответа.",
  tools,
});

const guestModel = genAI.getGenerativeModel({
  model: "gemini-3.6-flash",
  systemInstruction: "Ты — Даяана. Общайся живо и дружелюбно. Ты разговариваешь с гостем, у которого НЕТ доступа к управлению ноутом и личным данным владельца. Просто отвечай на вопросы и общайся, ничего не выполняй на компьютере.",
});
const guestHistories = new Map();

async function askGuestBrain(uid, userText) {
  if (!guestHistories.has(uid)) guestHistories.set(uid, []);
  const history = guestHistories.get(uid);
  const chat = guestModel.startChat({ history });
  const result = await chat.sendMessage(userText);
  const reply = result.response.text();
  history.push({ role: "user", parts: [{ text: userText }] });
  history.push({ role: "model", parts: [{ text: reply }] });
  return reply;
}

console.log("Даяана-агент запущен. Слушаю...");

function heartbeat() {
  db.collection("status").doc("laptop").set({
    online: true,
    lastSeen: FieldValue.serverTimestamp(),
  }).catch((err) => console.error("Ошибка маячка:", err.message));
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
  "хром": "start chrome",
  "chrome": "start chrome",
  "браузер": "start chrome",
  "блокнот": "notepad",
  "notepad": "notepad",
  "яндекс музыка": "start yandexmusic:",
  "музыка": "start yandexmusic:",
  "ворд": "start winword",
  "word": "start winword",
  "эксель": "start excel",
  "excel": "start excel",
  "калькулятор": "calc",
  "проводник": "explorer",
};

const nameAliases = {
  "телеграм": "telegram",
  "телега": "telegram",
  "гугл хром": "google chrome",
  "гугл": "google chrome",
  "дискорд": "discord",
  "стим": "steam",
  "спотифай": "spotify",
  "гитхаб": "github desktop",
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
    const foundKey = Object.keys(builtinCommands).find((k) => key.includes(k) || k.includes(key));
    cmd = foundKey ? builtinCommands[foundKey] : null;
  }

  if (!cmd) {
    const target = findInIndex(key);
    if (target) cmd = `"${target}"`;
  }

  if (!cmd) cmd = `start ${name}`;

  exec(cmd, (err) => { if (err) console.error("Ошибка запуска:", err.message); });
  return `Открываю: ${name}`;
}

db.collection("commands").where("status", "==", "pending")
  .onSnapshot((snapshot) => {
    snapshot.docChanges().forEach(async (change) => {
      if (change.type !== "added") return;
      const doc = change.doc;
      const data = doc.data();
      const result = openProgram(data.text || "");
      await doc.ref.update({ status: "done", result, completedAt: FieldValue.serverTimestamp() });
    });
  });

const chatHistory = [];

async function askBrain(userText) {
  chatHistory.push({ role: "user", parts: [{ text: userText }] });

  const openMatch = userText.toLowerCase().match(/(?:открой|запусти|включи)\s+(.+)/);
  if (openMatch) {
    const programName = openMatch[1].trim();
    const quickResult = openProgram(programName);
    chatHistory.push({ role: "model", parts: [{ text: quickResult }] });
    return quickResult;
  }

  const chat = model.startChat({ history: chatHistory.slice(0, -1) });

  let result = await chat.sendMessage(userText);
  let response = result.response;

  const calls = response.functionCalls();
  if (calls && calls.length > 0) {
    const call = calls[0];
    let funcResult = "Неизвестное действие";
    if (call.name === "open_program") {
      funcResult = openProgram(call.args.program);
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

// ---- Обработка сообщений с телефона/веб-приложения (через Firestore) ----
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

// ---- Обработка гостевых сообщений ----
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