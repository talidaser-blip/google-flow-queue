const promptsInput = document.getElementById("promptsInput");
const batchSizeInput = document.getElementById("batchSize");
const restMinutesInput = document.getElementById("restMinutes");
const genSecondsInput = document.getElementById("genSeconds");
const runBtn = document.getElementById("runBtn");
const stopBtn = document.getElementById("stopBtn");
const statusDiv = document.getElementById("status");

chrome.storage.local.get(["flowPrompts", "flowBatch", "flowRest", "flowGen", "flowStatus"], (res) => {
  if (res.flowPrompts) promptsInput.value = res.flowPrompts;
  if (res.flowBatch) batchSizeInput.value = res.flowBatch;
  if (res.flowRest) restMinutesInput.value = res.flowRest;
  if (res.flowGen) genSecondsInput.value = res.flowGen;
  if (res.flowStatus) statusDiv.textContent = res.flowStatus;
});

setInterval(() => {
  chrome.storage.local.get(["flowStatus", "flowRunning"], (res) => {
    if (res.flowStatus) statusDiv.textContent = res.flowStatus;
    runBtn.disabled = Boolean(res.flowRunning);
  });
}, 1000);

stopBtn.addEventListener("click", async () => {
  await chrome.storage.local.set({ flowStop: true, flowRunning: false, flowStatus: "Остановлено пользователем." });
  runBtn.disabled = false;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.debugger.detach({ tabId: tab.id }, () => void chrome.runtime.lastError);
  }
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const setStatus = (msg) => chrome.storage.local.set({ flowStatus: msg });
const isStopped = async () => {
  const r = await chrome.storage.local.get(["flowStop"]);
  return Boolean(r.flowStop);
};

runBtn.addEventListener("click", async () => {
  const rawText = promptsInput.value;
  const prompts = rawText
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*\d+\s*[,.)\-:]\s*/, "").trim())
    .filter(line => line.length > 3);

  if (prompts.length === 0) {
    statusDiv.textContent = "Ошибка: вставьте хотя бы один промпт (каждый с новой строки)!";
    return;
  }

  const batchSize = Math.max(1, parseInt(batchSizeInput.value, 10) || 5);
  const restMinutes = Math.max(1, parseInt(restMinutesInput.value, 10) || 5);
  const genSeconds = Math.max(15, parseInt(genSecondsInput.value, 10) || 25);

  await chrome.storage.local.set({
    flowPrompts: rawText,
    flowBatch: batchSize,
    flowRest: restMinutes,
    flowGen: genSeconds,
    flowStop: false,
    flowRunning: true,
    flowStatus: `Запуск очереди: всего ${prompts.length} промптов...`
  });

  runBtn.disabled = true;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.includes("google")) {
    const errText = "Ошибка: откройте вкладку с Google Flow!";
    statusDiv.textContent = errText;
    await chrome.storage.local.set({ flowRunning: false, flowStatus: errText });
    runBtn.disabled = false;
    return;
  }

  const debuggee = { tabId: tab.id };

  // Подключаем настоящий системный ввод (isTrusted: true)
  try {
    await new Promise((resolve, reject) => {
      chrome.debugger.attach(debuggee, "1.3", () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
  } catch (e) {
    await setStatus("Ошибка подключения к вкладке: " + e.message);
    await chrome.storage.local.set({ flowRunning: false });
    runBtn.disabled = false;
    return;
  }

  const sendCommand = (method, params = {}) => new Promise((resolve) => {
    chrome.debugger.sendCommand(debuggee, method, params, (res) => {
      void chrome.runtime.lastError;
      resolve(res);
    });
  });

  try {
    for (let i = 0; i < prompts.length; i++) {
      if (await isStopped()) break;

      // 1. Вставляем текст промпта в поле и находим точные координаты поля и круглой кнопки со стрелкой
      const [prepRes] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (text) => {
          const candidates = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]'))
            .filter(el => {
              const r = el.getBoundingClientRect();
              return el.offsetParent !== null && r.top > window.innerHeight * 0.45 && r.width > 200;
            });
          const box = candidates[candidates.length - 1];
          if (!box) return { ok: false };

          box.click();
          box.focus();

          if (box.tagName === "TEXTAREA" || box.tagName === "INPUT") {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
            if (setter) setter.call(box, text);
            else box.value = text;
            box.dispatchEvent(new Event("input", { bubbles: true }));
          } else {
            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(box);
            sel.removeAllRanges();
            sel.addRange(range);
            document.execCommand("insertText", false, text);
          }

          const boxRect = box.getBoundingClientRect();
          // Находим родительскую карточку нижней панели
          let container = box.parentElement;
          for (let d = 0; d < 6 && container; d++) {
            const r = container.getBoundingClientRect();
            if (r.width > 350 && r.height > 70) break;
            container = container.parentElement;
          }
          const scope = container || document;

          // Находим самую правую круглую кнопку со стрелкой внутри панели ввода
          const btns = Array.from(scope.querySelectorAll('button, [role="button"]')).filter(b => {
            if (b.offsetParent === null || b === box) return false;
            const r = b.getBoundingClientRect();
            return r.width >= 24 && r.width <= 55 && r.height >= 24 && r.height <= 55 &&
                   r.top >= boxRect.top && r.bottom <= boxRect.bottom + 95 &&
                   r.left > boxRect.left + boxRect.width * 0.65;
          });
          btns.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
          const arrowBtn = btns[0];

          const arrowRect = arrowBtn ? arrowBtn.getBoundingClientRect() : null;
          return {
            ok: true,
            boxX: Math.round(boxRect.left + 40),
            boxY: Math.round(boxRect.top + 15),
            btnX: arrowRect ? Math.round(arrowRect.left + arrowRect.width / 2) : null,
            btnY: arrowRect ? Math.round(arrowRect.top + arrowRect.height / 2) : null
          };
        },
        args: [prompts[i]]
      });

      const info = prepRes?.result;
      if (!info || !info.ok) {
        await setStatus("Ошибка: не найдено поле ввода промпта на странице Google Flow.");
        break;
      }

      await sleep(800);

      // 2. Делаем НАСТОЯЩИЙ клик мыши по круглой кнопке со стрелкой (или нажимаем настоящий Enter)
      if (info.btnX && info.btnY) {
        await sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: info.btnX, y: info.btnY });
        await sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: info.btnX, y: info.btnY, button: "left", clickCount: 1 });
        await sleep(80);
        await sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: info.btnX, y: info.btnY, button: "left", clickCount: 1 });
      } else {
        await sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: info.boxX, y: info.boxY, button: "left", clickCount: 1 });
        await sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: info.boxX, y: info.boxY, button: "left", clickCount: 1 });
        await sleep(150);
        await sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        await sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      }

      const currentNum = i + 1;
      const isEndOfBatch = currentNum % batchSize === 0 && currentNum < prompts.length;

      if (isEndOfBatch) {
        let restSec = restMinutes * 60;
        while (restSec > 0) {
          if (await isStopped()) break;
          const mins = Math.floor(restSec / 60);
          const secs = String(restSec % 60).padStart(2, "0");
          await setStatus(`Готово ${currentNum}/${prompts.length}. Отдых перед следующей пачкой: ${mins}:${secs}...`);
          await sleep(1000);
          restSec--;
        }
      } else if (currentNum < prompts.length) {
        for (let s = genSeconds; s > 0; s--) {
          if (await isStopped()) break;
          await setStatus(`Отправлен ${currentNum}/${prompts.length}. Жду рендер (${s} сек)...`);
          await sleep(1000);
        }
      }
    }

    if (!(await isStopped())) {
      await setStatus(`Готово! Все ${prompts.length} промптов отправлены в Google Flow.`);
    }
  } finally {
    await chrome.storage.local.set({ flowRunning: false });
    chrome.debugger.detach(debuggee, () => void chrome.runtime.lastError);
    runBtn.disabled = false;
  }
});
