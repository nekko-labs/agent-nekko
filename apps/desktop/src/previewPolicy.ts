export const PREVIEW_CHANNEL = 'nekko:isolated-preview';
export const MAX_PREVIEW_BYTES = 1_000_000;
export const PREVIEW_POLICY = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'; worker-src 'none'";

export function validPreviewSource(source: unknown): source is string {
  return typeof source === 'string' && new TextEncoder().encode(source).length <= MAX_PREVIEW_BYTES;
}

/** Only the initial document navigation is permitted; no subresources or redirects. */
export function previewRequestAllowed(url: string, type: string, documentUrl: string): boolean {
  return type === 'mainFrame' && url === documentUrl;
}
