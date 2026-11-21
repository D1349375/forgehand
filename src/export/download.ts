/**
 * Hands bytes to the browser as one download (requirement 50, design 7.5): a `Blob`, an object URL and a temporary
 * link that is clicked once and removed. The object URL is revoked right after the click. Browser only.
 */
export function downloadBytes(name: string, bytes: Uint8Array, mime: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
