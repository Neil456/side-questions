// Every chatgpt.com tab asks the background script whether it is the helper tab or a tab you read in.
chrome.runtime.sendMessage({ type: 'mg:hello', url: location.href }, (res) => {
  if (chrome.runtime.lastError || !res) return;
  if (res.role === 'worker') globalThis.MG.startWorker(res.job);
  else globalThis.MG.startReader();
});
