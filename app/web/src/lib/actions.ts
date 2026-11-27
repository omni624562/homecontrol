import { api } from "@/lib/api";
import type { AskAction } from "@/lib/types";

// Claude 給的草稿（問家裡、從習慣建議）：使用者按了「建立／確認」才真的做
export async function applyAction(x: AskAction): Promise<void> {
  if (x.kind === "power") await api("POST", `/api/plugs/${encodeURIComponent(x.plug!)}/power`, { on: x.on });
  else if (x.kind === "all_off") await api("POST", "/api/off", {});
  else if (x.kind === "schedule") await api("POST", "/api/schedules", x.body);
  else if (x.kind === "scene") await api("POST", "/api/scenes", x.body);
  else if (x.kind === "vision_on") await api("PUT", "/api/claude-vision", { on: true });
  else if (x.kind === "arrive") await (x.rule_id ? api("PUT", `/api/arrive-rules/${encodeURIComponent(x.rule_id)}`, x.body) : api("POST", "/api/arrive-rules", x.body));
  else if (x.kind === "motion") {
    const cur = await api<{ rules: unknown[] }>("GET", "/api/motion-rules");
    await api("PUT", "/api/motion-rules", { rules: [...cur.rules, x.body] });
  }
}
