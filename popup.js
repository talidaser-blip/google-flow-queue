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
  const prompts = rawText.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 3);

  if (prompts.length === 0) {
    statusDiv.textContent = "Ошибка: вставьте хотя бы один промпт (каждый с новой строки)!";
    return;
  }

  const batchSize = Math.max(1, parseInt(batchSizeInput.value, 10) || 5);
  const restMinutes = Math.max(1, parseInt(restMinutesInput.value, 10) || 5);
  const genSeconds = Math.max(10, parseInt(genSecondsInput.value, 10) || 22);

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
        const textareas = Array.from(document.querySelectorAll("textarea")).filter(el => el.offsetParent !== null);
        if (textareas.length > 0) return textareas[0];
        const editables = Array.from(document.querySelectorAll('[contenteditable="true"], [role="textbox"]')).filter(el => el.offsetParent !== null);
        return editables[0] || null;
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
          document.execCommand("insertText", false, text);
          el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
        }
      };

      const submitPrompt = (el) => {
        const buttons = Array.from(document.querySelectorAll("button")).filter(b => b.offsetParent !== null && !b.disabled);
        const sendBtn = buttons.find(b => {
          const label = (b.getAttribute("aria-label") || b.textContent || "").toLowerCase();
          return label.includes("generate") || label.includes("create") || label.includes("send") || label.includes("создать") || label.includes("сгенерировать");
        });

        if (sendBtn) {
          sendBtn.click();
        } else {
          el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
        }
      };

      for (let i = 0; i < promptList.length; i++) {
        if (await isStopped()) return;

        const box = findPromptBox();
        if (!box) {
          await setStatus("Ошибка: не найдено поле ввода промпта на странице Google Flow.");
          await chrome.storage.local.set({ flowRunning: false });
          return;
        }

        insertPromptText(box, promptList[i]);
        await sleep(600);
        submitPrompt(box);

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
