const https = require("https");

// ─── Simple in-process store (persists within one Vercel function instance) ───
// For true persistence across cold starts use Vercel KV / Upstash.
// The bot stores settings per chat_id in a module-level object.
const store = {};

function getSettings(chatId) {
  if (!store[chatId]) store[chatId] = { from: 1, to: 1000 };
  return store[chatId];
}

function setSettings(chatId, from, to) {
  store[chatId] = { from, to };
}

// ─── Telegram API helper ───────────────────────────────────────────────────────
const TOKEN = process.env.BOT_TOKEN;

function tgRequest(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: "api.telegram.org",
      path: `/bot${TOKEN}/${method}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    };
    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve({});
        }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// Send a reply to a specific message_id in the chat
function replyToMessage(chatId, replyToMsgId, text) {
  return tgRequest("sendMessage", {
    chat_id: chatId,
    text,
    reply_to_message_id: replyToMsgId,
    parse_mode: "HTML",
    allow_sending_without_reply: true, // send as normal msg if target deleted
  });
}

function sendMessage(chatId, text, extra = {}) {
  return tgRequest("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...extra,
  });
}

function answerCallback(callbackQueryId, text = "") {
  return tgRequest("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
  });
}

// ─── Settings inline keyboard ─────────────────────────────────────────────────
function settingsKeyboard(chatId) {
  const { from, to } = getSettings(chatId);
  return {
    inline_keyboard: [
      [
        { text: `📍 От: ${from}`, callback_data: "noop" },
        { text: "➖", callback_data: `from_dec_${chatId}` },
        { text: "➕", callback_data: `from_inc_${chatId}` },
      ],
      [
        { text: `📍 До: ${to}`, callback_data: "noop" },
        { text: "➖", callback_data: `to_dec_${chatId}` },
        { text: "➕", callback_data: `to_inc_${chatId}` },
      ],
      [
        { text: "✏️ Ввести вручную", callback_data: `manual_${chatId}` },
        { text: "✅ Готово", callback_data: `done_${chatId}` },
      ],
    ],
  };
}

function settingsText(chatId) {
  const { from, to } = getSettings(chatId);
  return (
    `⚙️ <b>Настройки диапазона</b>\n\n` +
    `Бот будет отвечать на случайное сообщение с ID от <b>${from}</b> до <b>${to}</b>.\n\n` +
    `Используй кнопки для изменения значений (шаг ×10 при зажатии не поддерживается — используй «Ввести вручную»).`
  );
}

// State for manual input: chatId → which field ("from"/"to")
const awaitingInput = {};

// ─── Main update handler ──────────────────────────────────────────────────────
async function handleUpdate(update) {
  // ── Callback query (inline buttons) ────────────────────────────────────────
  if (update.callback_query) {
    const cq = update.callback_query;
    const data = cq.data;
    const msgChatId = cq.message.chat.id;
    const msgId = cq.message.message_id;

    if (data === "noop") {
      await answerCallback(cq.id);
      return;
    }

    // Parse action and target chatId from callback data
    // Format: action_chatId  (e.g. from_inc_-1001234567)
    const match = data.match(/^(from_inc|from_dec|to_inc|to_dec|manual|done)_(-?\d+)$/);
    if (!match) {
      await answerCallback(cq.id);
      return;
    }

    const [, action, targetChatId] = match;
    const settings = getSettings(targetChatId);

    if (action === "from_inc") {
      settings.from = Math.min(settings.from + 1, settings.to);
      setSettings(targetChatId, settings.from, settings.to);
    } else if (action === "from_dec") {
      settings.from = Math.max(1, settings.from - 1);
      setSettings(targetChatId, settings.from, settings.to);
    } else if (action === "to_inc") {
      settings.to = settings.to + 1;
      setSettings(targetChatId, settings.from, settings.to);
    } else if (action === "to_dec") {
      settings.to = Math.max(settings.from, settings.to - 1);
      setSettings(targetChatId, settings.from, settings.to);
    } else if (action === "manual") {
      awaitingInput[msgChatId] = { field: null, step: "ask_field", settingsChatId: targetChatId, msgId };
      await answerCallback(cq.id);
      await tgRequest("editMessageText", {
        chat_id: msgChatId,
        message_id: msgId,
        text: "Что хочешь изменить вручную?",
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "От", callback_data: `setfield_from_${targetChatId}_${msgId}` },
              { text: "До", callback_data: `setfield_to_${targetChatId}_${msgId}` },
            ],
          ],
        },
      });
      return;
    } else if (action === "done") {
      await answerCallback(cq.id, "Настройки сохранены ✅");
      await tgRequest("editMessageReplyMarkup", {
        chat_id: msgChatId,
        message_id: msgId,
        reply_markup: { inline_keyboard: [] },
      });
      return;
    }

    await answerCallback(cq.id);
    // Update the settings message
    await tgRequest("editMessageText", {
      chat_id: msgChatId,
      message_id: msgId,
      text: settingsText(targetChatId),
      parse_mode: "HTML",
      reply_markup: settingsKeyboard(targetChatId),
    });
    return;
  }

  // Handle setfield callbacks (separate format)
  if (update.callback_query) return; // already handled above

  // ── Message ─────────────────────────────────────────────────────────────────
  const msg = update.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const text = msg.text || "";
  const userId = msg.from?.id;

  // ── Handle manual input awaiting ────────────────────────────────────────────
  if (awaitingInput[chatId]) {
    const state = awaitingInput[chatId];

    if (state.step === "awaiting_value") {
      const num = parseInt(text.trim(), 10);
      if (isNaN(num) || num < 1) {
        await sendMessage(chatId, "⚠️ Введи корректное число (≥ 1).");
        return;
      }
      const s = getSettings(state.settingsChatId);
      if (state.field === "from") {
        s.from = Math.min(num, s.to);
        setSettings(state.settingsChatId, s.from, s.to);
      } else {
        s.to = Math.max(num, s.from);
        setSettings(state.settingsChatId, s.from, s.to);
      }
      delete awaitingInput[chatId];
      await sendMessage(chatId, `✅ Значение сохранено.`);
      // Resend updated settings
      await sendMessage(chatId, settingsText(state.settingsChatId), {
        reply_markup: settingsKeyboard(state.settingsChatId),
      });
      return;
    }
  }

  // ── Commands ─────────────────────────────────────────────────────────────────
  const command = text.split(" ")[0].replace(/@.*$/, "").toLowerCase();

  // /start
  if (command === "/start") {
    await sendMessage(
      chatId,
      `👋 <b>Привет!</b> Я умею отвечать на случайное сообщение в группе.\n\n` +
        `📌 Команды:\n` +
        `/random — ответить на случайное сообщение\n` +
        `/settings — настроить диапазон ID сообщений\n\n` +
        `Добавь меня в группу и используй /settings для настройки диапазона.`
    );
    return;
  }

  // /settings
  if (command === "/settings") {
    await sendMessage(chatId, settingsText(chatId), {
      reply_markup: settingsKeyboard(chatId),
    });
    return;
  }

  // /random
  if (command === "/random") {
    const { from, to } = getSettings(chatId);
    const randomId = Math.floor(Math.random() * (to - from + 1)) + from;

    // Build the message link
    // For supergroups the chat id looks like -100XXXXXXXXXX
    // The link needs just the numeric part without -100
    let linkChatId = String(chatId);
    if (linkChatId.startsWith("-100")) {
      linkChatId = linkChatId.slice(4); // remove "-100"
    } else if (linkChatId.startsWith("-")) {
      linkChatId = linkChatId.slice(1);
    }

    const messageLink = `https://t.me/c/${linkChatId}/${randomId}`;

    // Reply to the random message
    const result = await replyToMessage(
      chatId,
      randomId,
      `🎲 Случайное сообщение #${randomId}\n🔗 <a href="${messageLink}">Открыть сообщение</a>`
    );

    // If message not found (deleted/doesn't exist), Telegram still sends it as normal message
    // but we can inform if needed. allow_sending_without_reply handles it gracefully.
    return;
  }
}

// ─── Vercel handler ───────────────────────────────────────────────────────────
// Also handle setfield callback that has different format
async function handleSetfieldCallback(update) {
  if (!update.callback_query) return false;
  const cq = update.callback_query;
  const data = cq.data;
  // Format: setfield_from_chatId_msgId  or  setfield_to_chatId_msgId
  const match = data.match(/^setfield_(from|to)_(-?\d+)_(\d+)$/);
  if (!match) return false;

  const [, field, targetChatId, msgId] = match;
  const msgChatId = cq.message.chat.id;

  awaitingInput[msgChatId] = {
    field,
    step: "awaiting_value",
    settingsChatId: targetChatId,
    msgId: parseInt(msgId),
  };

  await answerCallback(cq.id);
  await tgRequest("editMessageText", {
    chat_id: msgChatId,
    message_id: parseInt(msgId),
    text: `✏️ Введи новое значение для поля <b>${field === "from" ? "От" : "До"}</b>:`,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [] },
  });
  return true;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(200).json({ ok: true, info: "Telegram Bot Webhook" });
    return;
  }

  try {
    const update = req.body;

    // Try setfield callback first
    const handled = await handleSetfieldCallback(update);
    if (!handled) {
      await handleUpdate(update);
    }
  } catch (err) {
    console.error("Update error:", err);
  }

  res.status(200).json({ ok: true });
};
