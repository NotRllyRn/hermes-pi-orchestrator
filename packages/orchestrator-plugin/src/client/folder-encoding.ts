export function encodeFolderPath(cwd: string): string {
  const bytes = new TextEncoder().encode(cwd);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeFolderPath(encoded: string): string | null {
  try {
    const padded = encoded.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((encoded.length + 3) % 4);
    const binary = atob(padded);
    return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  } catch {
    return null;
  }
}
