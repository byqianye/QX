export function displaySource(value: string | null | undefined): string {
  const text = value?.trim() ?? "";
  if (!text) return "未连接";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text.length <= 64 ? text : `${text.slice(0, 36)}…${text.slice(-12)}`;
  try {
    const url = new URL(text);
    return `${url.protocol}//${url.host}/…`;
  } catch {
    if (text.length <= 64) return text;
    return `${text.slice(0, 36)}…${text.slice(-12)}`;
  }
}
