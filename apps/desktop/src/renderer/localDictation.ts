interface RecognitionResult { isFinal: boolean; 0: { transcript: string }; }
export interface LocalRecognition {
  processLocally: boolean;
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { resultIndex: number; results: ArrayLike<RecognitionResult> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
export interface LocalRecognitionConstructor {
  new(): LocalRecognition;
  available?(options: { langs: string[]; processLocally: true }): Promise<string>;
  install?(options: { langs: string[]; processLocally: true }): Promise<boolean>;
}

/** Refuse legacy recognition rather than risk sending microphone audio off-device. */
export async function createLocalRecognition(language = navigator.language, source: unknown = window): Promise<LocalRecognition> {
  const host = source as { SpeechRecognition?: LocalRecognitionConstructor; webkitSpeechRecognition?: LocalRecognitionConstructor };
  const Recognition = host.SpeechRecognition ?? host.webkitSpeechRecognition;
  if (!Recognition?.available) throw new Error('On-device dictation is not supported by this app build. No audio was sent to a cloud service.');
  const options = { langs: [language], processLocally: true as const };
  const available = await Recognition.available(options);
  if (available !== 'available') throw new Error(available === 'downloadable' || available === 'downloading'
    ? `The on-device speech pack for ${language} is not installed. Install it in your browser/OS speech settings, then try again.`
    : `On-device speech recognition is unavailable for ${language}. No cloud fallback was used.`);
  const recognition = new Recognition();
  if (!('processLocally' in recognition)) throw new Error('This app build cannot enforce local-only dictation.');
  recognition.processLocally = true;
  recognition.lang = language;
  recognition.continuous = true;
  recognition.interimResults = true;
  return recognition;
}
