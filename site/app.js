const year = document.querySelector("#current-year");
const copyButton = document.querySelector("#copy-command");

if (year) {
  year.textContent = String(new Date().getFullYear());
}

copyButton?.addEventListener("click", async () => {
  const command = copyButton.dataset.copy;
  if (!command) return;

  try {
    await navigator.clipboard.writeText(command);
    copyButton.textContent = "已复制";
  } catch {
    copyButton.textContent = "复制失败";
  }

  window.setTimeout(() => {
    copyButton.textContent = "复制";
  }, 1800);
});
