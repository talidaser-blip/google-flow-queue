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

stopBtn.addEventListener("click", () => {
  chrome.storage.local.set({ flowStop: true, flowRunning: false, flowStatus: "Остановлено пользователем." });
  runBtn.disabled = false;
});

runBtn.addEventListener("click", async () => {
  const rawText = promptsInput.value;
  // Убираем номера в начале строк ("1,", "2." и т.д.)
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
  const genSeconds = Math.max(12, parseInt(genSecondsInput.value, 10) || 25);

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

  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async (promptList, batch, restMin, genSec) => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const setStatus = (msg) => chrome.storage.local.set({ flowStatus: msg });
      const isStopped = async () => {
        const r = await chrome.storage.local.get(["flowStop"]);
        return Boolean(r.flowStop);
      };

      const findPromptBox = () => {
        const candidates = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]'))
          .filter(el => {
            const r = el.getBoundingClientRect();
            return el.offsetParent !== null && r.top > window.innerHeight * 0.45 && r.width > 200;
          });
        return candidates[candidates.length - 1] || null;
      };

      const insertPromptText = (el, text) => {
        el.click();
        el.focus();
        if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
          if (setter) setter.call(el, text);
          else el.value = text;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
          // Выделяем существующий текст и вставляем новый как при Ctrl+V
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(el);
          selection.removeAllRanges();
          selection.addRange(range);
          document.execCommand("insertText", false, text);
        }
      };

      const clickArrowSubmit = (boxEl) => {
        // Находим общий нижний контейнер карточки ввода
        let container = boxEl.parentElement;
        for (let d = 0; d < 5 && container; d++) {
          const r = container.getBoundingClientRect();
          if (r.width > 350 && r.height > 60) break;
          container = container.parentElement;
        }
        const scope = container || document;
        const boxRect = boxEl.getBoundingClientRect();

        // Ищем все видимые кнопки в нижней правой части панели ввода
        const buttons = Array.from(scope.querySelectorAll('button, [role="button"]')).filter(b => {
          if (b.offsetParent === null || b.disabled || b === boxEl) return false;
          const r = b.getBoundingClientRect();
          return r.width >= 20 && r.width <= 60 && r.height >= 20 && r.height <= 60 &&
                 r.top >= boxRect.top - 10 && r.bottom <= boxRect.bottom + 90 &&
                 r.left > boxRect.left + boxRect.width * 0.6;
        });

        // Сортируем строго по правому краю: самая правая кнопка — это круглая стрелка отправки
        buttons.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
        const arrowBtn = buttons[0];

        if (arrowBtn) {
          arrowBtn.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
          arrowBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          arrowBtn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
          arrowBtn.click();
          return true;
        }
        return false;
      };

      for (let i = 0; i < promptList.length; i++) {
        if (await isStopped()) return;

        const box = findPromptBox();
        if (!box) {
          await setStatus("Ошибка: не найдено нижнее поле ввода промпта в Google Flow.");
          await chrome.storage.local.set({ flowRunning: false });
          return;
        }

        // 1. Вставляем текст и даём React 1.2 секунды на обновление состояния кнопки
        insertPromptText(box, promptList[i]);
        await sleep(1200);

        // 2. Нажимаем самую правую круглую кнопку со стрелкой
        const clicked = clickArrowSubmit(box);

        // 3. Если вдруг поле не очистилось через 800 мс — дожимаем чистым Enter
        await sleep(800);
        const currentVal = (box.value !== undefined ? box.value : box.textContent) || "";
        if (currentVal.trim().length > 0) {
          box.focus();
          box.dispatchEvent(new KeyboardEvent("keydown", {
            key: "Enter", code: "Enter", keyCode: 13, which: 13, shiftKey: false, bubbles: true, cancelable: true
          }));
        }

        const currentNum = i + 1;
        const isEndOfBatch = currentNum % batch === 0 && currentNum < promptList.length;

        if (isEndOfBatch) {
          let restSec = restMin * 60;
          while (restSec > 0) {
            if (await isStopped()) return;
            const mins = Math.floor(restSec / 60);
            const secs = String(restSec % 60).padStart(2, "0");
            await setStatus(`Готово ${currentNum}/${promptList.length}. Отдых перед следующей пачкой: ${mins}:${secs}...`);
            await sleep(1000);
            restSec--;
          }
        } else if (currentNum < promptList.length) {
          for (let s = genSec; s > 0; s--) {
            if (await isStopped()) return;
            await setStatus(`Отправлен ${currentNum}/${promptList.length}. Жду рендер (${s} сек)...`);
            await sleep(1000);
          }
        }
      }

      await setStatus(`Готово! Все ${promptList.length} промптов отправлены в Google Flow.`);
      await chrome.storage.local.set({ flowRunning: false });
    },
    args: [prompts, batchSize, restMinutes, genSeconds]
  });
});
