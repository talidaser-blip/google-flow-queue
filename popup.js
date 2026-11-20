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
  // Убираем случайные номера в начале строк вроде "1," или "2."
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
  const genSeconds = Math.max(10, parseInt(genSecondsInput.value, 10) || 25);

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
        // Ищем нижнее поле ввода промпта (не верхнюю строку поиска по библиотеке)
        const candidates = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]'))
          .filter(el => {
            const r = el.getBoundingClientRect();
            return el.offsetParent !== null && r.top > window.innerHeight * 0.45 && r.width > 200;
          });
        return candidates[candidates.length - 1] || null;
      };

      const insertPromptText = (el, text) => {
        el.focus();
        if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
          if (setter) setter.call(el, text);
          else el.value = text;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
          document.execCommand("selectAll", false, null);
          document.execCommand("delete", false, null);
          document.execCommand("insertText", false, text);
          el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
        }
      };

      const findSubmitButton = (boxEl) => {
        const boxRect = boxEl.getBoundingClientRect();
        // Ищем кнопки внутри или вплотную к нижней панели ввода (справа внизу от текста)
        const allButtons = Array.from(document.querySelectorAll("button")).filter(b => {
          if (b.offsetParent === null || b.disabled) return false;
          const r = b.getBoundingClientRect();
          return r.top >= boxRect.top - 20 && r.bottom <= boxRect.bottom + 80 && r.left > boxRect.left + boxRect.width * 0.5;
        });

        // Приоритет: самая правая кнопка в нижней панели (круглая кнопка со стрелкой отправки)
        allButtons.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
        return allButtons[0] || null;
      };

      for (let i = 0; i < promptList.length; i++) {
        if (await isStopped()) return;

        const box = findPromptBox();
        if (!box) {
          await setStatus("Ошибка: не найдено нижнее поле ввода промпта в Google Flow.");
          await chrome.storage.local.set({ flowRunning: false });
          return;
        }

        // Ждём, если предыдущая генерация ещё блокирует отправку
        for (let w = 0; w < 15; w++) {
          if (await isStopped()) return;
          insertPromptText(box, promptList[i]);
          await sleep(400);
          const btn = findSubmitButton(box);
          if (btn && !btn.disabled) {
            btn.click();
            await sleep(500);
            // Проверяем, очистилось ли поле ввода (значит, Flow принял запрос)
            const currentVal = (box.value !== undefined ? box.value : box.textContent) || "";
            if (currentVal.trim().length === 0) {
              break;
            }
          }
          // Запасной вариант — Enter
          box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
          await sleep(1500);
          const afterEnterVal = (box.value !== undefined ? box.value : box.textContent) || "";
          if (afterEnterVal.trim().length === 0) {
            break;
          }
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
