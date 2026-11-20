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
    // 這台裝置還沒配對（或被移除了）：換成配對畫面
    if (res.status === 401) window.dispatchEvent(new Event("plughub:unpaired"));
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}
