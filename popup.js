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

  const getFlowCoords = async () => {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        // Ищем нижнюю панель ввода по тексту плейсхолдера или по положению в нижней трети экрана
        const allInputs = Array.from(document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"], [role="textbox"]'))
          .filter(el => {
            const r = el.getBoundingClientRect();
            return el.offsetParent !== null && r.top > window.innerHeight * 0.55 && r.width > 120;
          });

        let box = allInputs[allInputs.length - 1] || null;

        // Запасной поиск по надписи "Что вы хотите создать?" / "What do you want to create"
        if (!box) {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            const txt = node.nodeValue || "";
            if (txt.includes("Что вы хотите создать") || txt.includes("Опишите свою цель") || txt.includes("What do you want")) {
              const el = node.parentElement;
              if (el && el.getBoundingClientRect().top > window.innerHeight * 0.55) {
                box = el;
                break;
              }
            }
          }
        }

        if (!box) return { ok: false };

        const boxRect = box.getBoundingClientRect();
        const textVal = (box.value !== undefined ? box.value : box.innerText) || "";
        const isPlaceholder = textVal.includes("Что вы хотите создать") || textVal.includes("Опишите свою цель") || textVal.includes("Что дальше");

        // Ищем общий нижний контейнер капсулы ввода
        let container = box.parentElement;
        for (let d = 0; d < 6 && container; d++) {
          const r = container.getBoundingClientRect();
          if (r.width > 320 && r.height >= 40) break;
          container = container.parentElement;
        }
        const scope = container || document;
        const scopeRect = container ? container.getBoundingClientRect() : boxRect;

        // Самая правая круглая кнопка со стрелкой внутри капсулы
        const btns = Array.from(scope.querySelectorAll('button, [role="button"]')).filter(b => {
          if (b.offsetParent === null || b === box) return false;
          const r = b.getBoundingClientRect();
          return r.width >= 22 && r.width <= 55 && r.height >= 22 && r.height <= 55 &&
                 r.top >= scopeRect.top - 10 && r.bottom <= scopeRect.bottom + 15 &&
                 r.left > scopeRect.left + scopeRect.width * 0.6;
        });
        btns.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
        const arrowBtn = btns[0];
        const arrowRect = arrowBtn ? arrowBtn.getBoundingClientRect() : null;

        return {
          ok: true,
          hasText: !isPlaceholder && textVal.trim().length > 0,
          boxX: Math.round(boxRect.left + Math.min(80, boxRect.width / 2)),
          boxY: Math.round(boxRect.top + boxRect.height / 2),
          btnX: arrowRect ? Math.round(arrowRect.left + arrowRect.width / 2) : null,
          btnY: arrowRect ? Math.round(arrowRect.top + arrowRect.height / 2) : null
        };
      }
    });
    return res?.result || { ok: false };
  };

  try {
    for (let i = 0; i < prompts.length; i++) {
      if (await isStopped()) break;

      const coords = await getFlowCoords();
      if (!coords.ok) {
        await setStatus("Ошибка: не найдено поле «Что вы хотите создать?» внизу страницы.");
        break;
      }

      // 1. Кликаем мышкой прямо в поле ввода, выделяем всё (Ctrl+A), очищаем и вставляем текст системно
      await sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: coords.boxX, y: coords.boxY });
      await sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: coords.boxX, y: coords.boxY, button: "left", clickCount: 1 });
      await sleep(60);
      await sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: coords.boxX, y: coords.boxY, button: "left", clickCount: 1 });
      await sleep(250);

      // Ctrl + A и Backspace на случай, если в поле что-то осталось
      await sendCommand("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
      await sendCommand("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
      await sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
      await sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
      await sleep(150);

      // Системная вставка текста промпта (работает в любом поле Google)
      await sendCommand("Input.insertText", { text: prompts[i] });
      await sleep(800);

      // 2. Пересчитываем координаты круглой кнопки со стрелкой (панель могла расшириться вверх от длинного текста!)
      for (let attempt = 0; attempt < 5; attempt++) {
        if (await isStopped()) break;
        const fresh = await getFlowCoords();
        if (!fresh.ok || !fresh.hasText) break;

        if (fresh.btnX && fresh.btnY) {
          await sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: fresh.btnX, y: fresh.btnY });
          await sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: fresh.btnX, y: fresh.btnY, button: "left", clickCount: 1 });
          await sleep(80);
          await sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: fresh.btnX, y: fresh.btnY, button: "left", clickCount: 1 });
        } else {
          await sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
          await sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        }
        await sleep(1200);
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
