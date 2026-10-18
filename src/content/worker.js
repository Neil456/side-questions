// Runs in the pinned helper tab. Receives one job at a time from the background script, asks ChatGPT
// in this tab, and streams the answer back.
(() => {
  const MG = (globalThis.MG = globalThis.MG || {});
  const { gpt } = MG;
  let busy = false;

  function banner() {
    if (document.getElementById('mg-worker-banner')) return;
    const b = document.createElement('div');
    b.id = 'mg-worker-banner';
    b.textContent = 'Marginalia helper tab: your side questions are asked here. Keep it open.';
    document.documentElement.appendChild(b);
  }

  function withTranscript(transcript, prompt) {
    return [
      "Here is a conversation I'm studying. I'll ask a side question about it below.",
      '',
      '<transcript>',
      transcript,
      '</transcript>',
      '',
      prompt,
    ].join('\n');
  }

  async function run(job) {
    if (busy) return false;
    busy = true;
    let status = 'Starting…';
    const post = (msg) => chrome.runtime.sendMessage({ jobId: job.id, ...msg }).catch(() => {});
    const setStatus = (s) => {
      status = s;
      post({ type: 'mg:progress', status });
    };
    const heartbeat = setInterval(() => post({ type: 'mg:progress', status }), 4000);
    const mainId = gpt.conversationId(job.mainUrl);

    try {
      if (job.kind === 'branch') {
        setStatus('Branching your conversation…');
        await gpt.waitForConversation();
        try {
          await gpt.branchFromLatest();
        } catch (e) {
          if (e.code !== 'NO_BRANCH') throw e;
          post({ type: 'mg:fail', error: e.message, fallback: { transcript: gpt.transcript() } });
          return true;
        }
      } else if (job.kind === 'followup') {
        await gpt.waitForConversation();
      } else {
        await gpt.waitForComposer();
      }

      // Never type into the conversation the user is reading.
      const here = gpt.conversationId(location.href);
      if (mainId && here === mainId) throw new Error('Refusing to post in your main conversation.');
      if (job.kind === 'followup' && here !== gpt.conversationId(job.branchUrl)) {
        throw new Error('This side thread’s chat could not be opened. It may have been deleted.');
      }

      setStatus('Asking…');
      const prompt = job.kind === 'fresh' ? withTranscript(job.transcript || '', job.prompt) : job.prompt;
      const known = gpt.knownAssistantIds();
      await gpt.submitPrompt(prompt);
      setStatus('Thinking…');
      const result = await gpt.readResponse(known, (html, className) => {
        status = 'Answering…';
        post({ type: 'mg:progress', status, html, className });
      });
      const url = new URL(location.href);
      post({ type: 'mg:done', html: result.html, className: result.className, branchUrl: url.origin + url.pathname });
    } catch (e) {
      post({ type: 'mg:fail', error: e?.message || String(e) });
    } finally {
      clearInterval(heartbeat);
      busy = false;
    }
    return true;
  }

  MG.startWorker = function (job) {
    banner();
    chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
      if (msg.type !== 'mg:run') return;
      if (busy) reply({ ok: false, busy: true });
      else {
        reply({ ok: true });
        run(msg.job);
      }
    });
    if (job) run(job);
  };
})();
