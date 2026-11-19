// 呼叫家庭中控的 API；錯誤訊息用伺服器回的中文說明
export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      msg = (await res.json()).detail || msg;
    } catch {
      /* 不是 JSON */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}
