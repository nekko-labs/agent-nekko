import { BrowserWindow, desktopCapturer } from 'electron';

const selections = new Map<string, Map<string, string>>();
let recording = false;

/** Window-only capture. Source capabilities are scoped to the requesting chat. */
export async function captureWindow(sessionId: string, input: Record<string, unknown>, recorderUrl?: string, ownedWindow?: BrowserWindow): Promise<unknown> {
  const action = input.action;
  if (!['list', 'screenshot', 'record'].includes(String(action))) throw new Error('Invalid capture action');
  if (action === 'list') {
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
    const windows = sources.map((s) => ({ id: s.id, title: s.name }));
    if (ownedWindow && !ownedWindow.isDestroyed()) windows.push({ id: `nekko:${ownedWindow.id}`, title: 'Nekko Browser (owned by this chat)' });
    selections.set(sessionId, new Map(windows.map((s) => [s.id, s.title])));
    return { windows };
  }
  const id = String(input.window_id ?? '');
  const title = selections.get(sessionId)?.get(id);
  if (!title) throw new Error('List windows first and select an id belonging to this chat');
  if (id.startsWith('nekko:')) {
    if (!ownedWindow || ownedWindow.isDestroyed() || id !== `nekko:${ownedWindow.id}`) throw new Error('Owned window disappeared; list windows again');
    if (action !== 'screenshot') throw new Error('Hidden owned windows support PNG screenshots only; recordings require an OS-listed window');
    const image = await ownedWindow.capturePage(undefined, { stayHidden: true, stayAwake: false });
    if (image.isEmpty()) throw new Error('Owned window did not produce a frame; retry after the page finishes rendering');
    return { title, window_id: id, capturedAt: Date.now(), ...image.getSize(), mime: 'image/png', data: image.toPNG().toString('base64'), source: 'owned-page', background: true };
  }
  if (action === 'screenshot') {
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 3840, height: 2160 }, fetchWindowIcons: false });
    const source = sources.find((s) => s.id === id && s.name === title);
    if (!source || source.thumbnail.isEmpty()) throw new Error('Selected window disappeared or could not be captured in the background. Hidden/minimized/protected windows depend on OS support; no window was restored or focused. Check OS capture permissions.');
    return { title, window_id: id, capturedAt: Date.now(), ...source.thumbnail.getSize(), mime: 'image/png', data: source.thumbnail.toPNG().toString('base64'), source: 'native-window', background: true };
  }
  const seconds = Number(input.seconds ?? 5);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 15) throw new Error('Recording duration must be 1–15 seconds');
  if (recording) throw new Error('Another window recording is in progress');
  recording = true;
  const win = new BrowserWindow({ show: false, width: 1, height: 1, webPreferences: { partition: `capture-${sessionId}-${Date.now()}`, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    const source = (await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } })).find((s) => s.id === id && s.name === title);
    if (!source) throw new Error('Selected window disappeared; list windows again');
    // Only this isolated, temporary recorder gets a display-media grant. It
    // never opens remote content, exposes a preload, or requests audio.
    win.webContents.session.setDisplayMediaRequestHandler((_request, callback) => callback({ video: source }));
    if (!recorderUrl || !recorderUrl.startsWith('http://127.0.0.1:')) throw new Error('Local recorder page is unavailable');
    await win.loadURL(recorderUrl);
    const result = await win.webContents.executeJavaScript(`(async () => {
      const acquire = navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
      let acquisitionTimer;
      const stream = await Promise.race([acquire, new Promise((_, reject) => { acquisitionTimer = setTimeout(() => reject(new Error('OS window capture did not start within 5 seconds')), 5000); })]).finally(() => clearTimeout(acquisitionTimer));
      try {
        const track = stream.getVideoTracks()[0];
        const recorder = new MediaRecorder(stream, { mimeType: 'video/webm', videoBitsPerSecond: 2000000 });
        const chunks = [];
        const blob = await new Promise((resolve, reject) => {
          let bytes = 0;
          const timer = setTimeout(() => recorder.stop(), ${seconds * 1000});
          recorder.ondataavailable = (e) => { bytes += e.data.size; if (bytes > 20 * 1024 * 1024) { clearTimeout(timer); recorder.stop(); reject(new Error('Recording exceeds 20 MB limit')); } else chunks.push(e.data); };
          recorder.onerror = () => { clearTimeout(timer); reject(new Error('Window recording failed')); };
          track.onended = () => { clearTimeout(timer); if (recorder.state !== 'inactive') recorder.stop(); reject(new Error('Capture source ended during recording')); };
          recorder.onstop = () => { clearTimeout(timer); resolve(new Blob(chunks, { type: 'video/webm' })); };
          recorder.start(250);
        });
        const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = () => reject(new Error('Could not encode recording')); reader.readAsDataURL(blob); });
        const { width, height } = track.getSettings();
        return { data, width, height };
      } finally { stream.getTracks().forEach(t => t.stop()); }
    })()`, true);
    return { ...result, title, window_id: id, capturedAt: Date.now(), seconds, mime: 'video/webm' };
  } finally {
    win.webContents.session.setDisplayMediaRequestHandler(null);
    win.destroy();
    recording = false;
  }
}
