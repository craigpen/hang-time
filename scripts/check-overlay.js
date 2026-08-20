async function inspectOpacity() {
  for (const port of [9222, 9223]) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`);
      const targets = await res.json();
      const yt = targets.find(t => t.url && t.url.includes('youtube.com'));
      if (!yt) continue;
      const ws = new WebSocket(yt.webSocketDebuggerUrl);
      await new Promise((resolve) => {
        ws.onopen = () => {
          ws.send(JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: {
              expression: `(() => {
                const el = document.getElementById('hang-time-overlay');
                if (!el) return 'no el';
                return {
                  outerHTMLPrefix: el.outerHTML.substring(0, 150),
                  classes: Array.from(el.classList),
                  styleAttr: el.getAttribute('style'),
                  opacity: window.getComputedStyle(el).opacity,
                  visibility: window.getComputedStyle(el).visibility,
                  display: window.getComputedStyle(el).display
                };
              })()`,
              returnByValue: true
            }
          }));
        };
        ws.onmessage = (e) => {
          const msg = JSON.parse(e.data);
          if (msg.id === 1) {
            console.log(`Port ${port}:`, msg.result?.result?.value);
            ws.close();
            resolve();
          }
        };
      });
    } catch (err) {
      console.error(`Port ${port} error:`, err.message);
    }
  }
}

inspectOpacity();
