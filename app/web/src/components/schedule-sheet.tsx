import { useEffect, useState, type ReactNode } from "react";
import { AlertCircle, CalendarClock, CheckCircle2, Clock, Droplets, Info, Loader2, PlugZap, Trash2, Umbrella } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ClockPicker, DurationPicker } from "@/components/duration-picker";
import { mdiIcon } from "@/components/icons";
import { Sheet } from "@/components/responsive-sheet";
import { ChoiceChip, DayPicker, PlugPicker, Segmented, SunOffset, TimeModePicker, daysText, kasaDays, minText, sunLabel, useRuleMin } from "@/components/schedule-bits";
import { Group, Row, Section } from "@/components/settings-bits";
import { api } from "@/lib/api";
import { fmt, pad2 } from "@/lib/format";
import { useHub } from "@/lib/hub";
import type { HabitSuggestion, Schedule } from "@/lib/types";
import { cn } from "@/lib/utils";

export type SchedOpen = { id?: string; template?: "night" | "leave" | "water"; sugg?: HabitSuggestion } | null;
type Draft = Omit<Schedule, "id">;

// 一行狀態說明
export function StatLine({ icon: I, children, tone }: { icon: React.ElementType; children: ReactNode; tone?: "ok" | "bad" }) {
  return (
    <div className={cn("flex items-start gap-2 text-sm leading-relaxed text-muted-foreground", tone === "ok" && "text-emerald-700 dark:text-emerald-400", tone === "bad" && "text-orange-700 dark:text-orange-400")}>
      <I className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0">{children}</span>
    </div>
  );
}

// 下雨不執行：現在查到的雨量，和今天會不會跳過
export function RainLines() {
  const { state } = useHub();
  const c = state?.calendar;
  const w = c?.weather;
  if (!w) return <StatLine icon={AlertCircle} tone="bad">還沒有氣象署授權碼：打開首頁的天氣面板貼上，才能判斷下雨</StatLine>;
  if (!w.updated) return <StatLine icon={Info}>還沒查過天氣：儲存之後幾秒內會查一次</StatLine>;
  const r = w.rain;
  const t = new Date(w.updated * 1000);
  const v = (x: number | null) => (x == null ? "—" : `${fmt(x, x < 10 ? 1 : 0)} mm`);
  const p = (x: number | null) => (x == null ? "—" : `${fmt(x)}%`);
  return (
    <>
      <StatLine icon={Droplets}>{r ? `${r.station}雨量站：過去 24 小時 ${v(r.past24h)}・今天累積 ${v(r.today)}` : "附近沒有雨量站資料"}</StatLine>
      <StatLine icon={Umbrella}>氣象署預報白天降雨機率：今天 {p(w.pop_today)}・明天 {p(w.pop_tomorrow)}</StatLine>
      {c?.rain ? (
        <StatLine icon={AlertCircle} tone="bad">今天會跳過：{c.rain}</StatLine>
      ) : (
        <StatLine icon={CheckCircle2} tone="ok">今天照常執行（過去 24 小時超過 {w.rain_mm} mm，或白天降雨機率 {w.rain_pop}% 以上才跳過）</StatLine>
      )}
      <StatLine icon={Clock}>{pad2(t.getHours())}:{pad2(t.getMinutes())} 更新</StatLine>
    </>
  );
}

function initDraft(o: NonNullable<SchedOpen>, existing: Schedule | undefined, ctx: ReturnType<typeof useHub>["state"]): Draft {
  if (existing) return { ...existing, days: [...existing.days], plugs: [...existing.plugs] };
  const d: Draft = { enabled: true, time: "23:00:00", days: [0, 1, 2, 3, 4, 5, 6], action: "off", scene: null, plugs: [], restore_at: null, duration_s: null, backup: true, time_mode: "clock", offset_min: 0 };
  const plugs = ctx?.plugs || [];
  const scenes = ctx?.scenes || [];
  if (o.template === "night") {
    d.plugs = plugs.filter((p) => /燈|lamp|light/i.test(p.name) && !p.keep_on).map((p) => p.id);
    d.restore_at = "07:00:00";
  } else if (o.template === "leave") {
    const sc = scenes.find((s) => s.name === "出門") || scenes[0];
    Object.assign(d, { time: "08:30:00", days: [0, 1, 2, 3, 4], action: "scene", scene: sc?.id || null, skip_holiday: true });
  } else if (o.template === "water") {
    Object.assign(d, { time: "06:30:00", action: "on", duration_s: 60, skip_rain: true, plugs: plugs.filter((p) => /澆水|water/i.test(p.name)).map((p) => p.id) });
  }
  if (o.sugg) {
    const s = o.sugg;
    Object.assign(d, { time: `${s.time}:00`, days: [...s.days], action: s.action, plugs: [s.plug], time_mode: s.mode, offset_min: s.offset_min });
  }
  return d;
}

// 「下次：明天 07:00」
function nextRun(d: Draft, saved?: Schedule) {
  if (!d.enabled) return "暫停中，不會執行";
  if (!d.days.length) return "還沒選日子";
  const mode = d.time_mode || "clock";
  const sun = mode !== "clock";
  const t = sun ? saved?.today || "" : d.time;
  const now = new Date();
  const today = (now.getDay() + 6) % 7;
  const p2 = (n: number) => String(n).padStart(2, "0");
  const hms = `${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`;
  for (let i = 0; i < 8; i++) {
    const day = (today + i) % 7;
    if (!d.days.includes(day) || (i === 0 && !!t && t <= hms)) continue;
    const when = i === 0 ? "今天" : i === 1 ? "明天" : `星期${"一二三四五六日"[day]}`;
    const clock = t ? (t.endsWith(":00") ? t.slice(0, 5) : t) : "";
    const name = mode === "sunrise" ? "日出" : "日落";
    return `下次：${when} ${sun ? name + (clock ? `（約 ${clock}）` : "") : clock}`;
  }
  return undefined;
}

export function ScheduleSheet({ open, onClose }: { open: SchedOpen; onClose: () => void }) {
  const { state } = useHub();
  const existing = open?.id ? state?.schedules.find((x) => x.id === open.id) : undefined;
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => {
    if (open) setDraft(initDraft(open, existing, state));
    else setDraft(null);
    // 只在打開時建立草稿；之後伺服器更新不覆蓋正在編輯的內容
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <Sheet
      open={!!open && !!draft}
      onOpenChange={(v) => !v && onClose()}
      title={open?.id ? "編輯排程" : "新增排程"}
      description={draft ? nextRun(draft, existing) : undefined}
      icon={<CalendarClock />}
      wide="xl"
      aside={
        open?.id && draft ? (
          <label className="flex items-center gap-2 text-sm font-medium">
            {draft.enabled ? "啟用中" : "已暫停"}
            <Switch size="lg" checked={draft.enabled} onCheckedChange={(v) => setDraft({ ...draft, enabled: v })} aria-label="啟用排程" />
          </label>
        ) : undefined
      }
    >
      {open && draft && <Body id={open.id} saved={existing} d={draft} set={setDraft} onClose={onClose} />}
    </Sheet>
  );
}

function Body({ id, saved, d, set, onClose }: { id?: string; saved?: Schedule; d: Draft; set: (d: Draft) => void; onClose: () => void }) {
  const { state } = useHub();
  const ruleMin = useRuleMin();
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [err, setErr] = useState("");
  const up = (patch: Partial<Draft>) => {
    setErr("");
    set({ ...d, ...patch });
  };
  const mode = d.time_mode || "clock";
  const scenes = state?.scenes || [];

  const save = async () => {
    if (!d.days.length) return setErr("請至少選一天");
    if (d.action === "scene" && !d.scene) return setErr("請選一個情境");
    if (d.action !== "scene" && !d.plugs.length) return setErr("請至少選一個插座");
    const body = {
      enabled: id ? d.enabled : true,
      time: d.time, days: d.days, action: d.action, scene: d.scene, plugs: d.plugs,
      restore_at: d.action === "off" ? d.restore_at : null,
      duration_s: d.action === "on" ? d.duration_s || null : null,
      backup: d.backup !== false, time_mode: mode, offset_min: d.offset_min || 0,
      skip_holiday: !!d.skip_holiday, skip_rain: !!d.skip_rain,
    };
    setBusy("save");
    try {
      if (id) await api("PUT", `/api/schedules/${id}`, body);
      else await api("POST", "/api/schedules", body);
      toast.success(id ? "排程已更新" : "已新增排程");
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    setBusy("delete");
    try {
      await api("DELETE", `/api/schedules/${id}`);
      toast.success("已刪除排程");
      onClose();
    } catch (e) {
      toast.error("沒有成功", { description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  // 備援的狀態、實際寫進插座的內容（插座只到分鐘）
  const b = saved?.backup_status;
  const showBackup = d.backup && saved && saved.backup !== false && b && b.total;
  const rules = d.backup && saved && saved.backup !== false && b?.rules?.length
    ? Object.entries(
        b.rules
          .map(([act, opt, val, wday]) => ({ act, opt, val, wday }))
          .sort((x, y) => ruleMin(x) - ruleMin(y))
          .reduce<Record<string, string[]>>((g, r) => {
            const k = daysText(kasaDays(r.wday));
            (g[k] ||= []).push(`${r.opt ? sunLabel(r.opt, r.val) : minText(r.val)} ${r.act ? "開" : "關"}`);
            return g;
          }, {}),
      ).map(([days, list]) => `${days} ${list.join("、")}`).join("；")
    : "";

  return (
    <div className="space-y-5">
      <div className="grid gap-6 md:grid-cols-2">
        <div className="min-w-0 space-y-5">
          <Section title="什麼時候">
            <TimeModePicker value={mode} onChange={(v) => up({ time_mode: v })} />
            {mode === "clock" ? <ClockPicker value={d.time} onChange={(t) => up({ time: t })} /> : <SunOffset mode={mode} offset={d.offset_min || 0} onChange={(v) => up({ offset_min: v })} />}
          </Section>
          <Section title={`哪幾天・${daysText(d.days)}`}>
            <DayPicker days={d.days} onChange={(v) => up({ days: v })} />
          </Section>
          <Section title="什麼時候不執行">
            <Group>
              <Row label="國定假日不執行" hint="平日遇到國定假日、補假就跳過（假日表來自政府公告）；颱風假可以在排程頁按「今天放假」" htmlFor="sk-h">
                <Switch id="sk-h" checked={!!d.skip_holiday} onCheckedChange={(v) => up({ skip_holiday: v })} />
              </Row>
              <Row label="下雨不執行" hint="最近的氣象署雨量站過去 24 小時下超過 3 mm，或氣象署預報白天降雨機率 70% 以上就跳過，適合澆水" htmlFor="sk-r">
                <Switch id="sk-r" checked={!!d.skip_rain} onCheckedChange={(v) => up({ skip_rain: v })} />
              </Row>
              {d.skip_rain && <div className="space-y-1.5 px-4 py-3"><RainLines /></div>}
            </Group>
          </Section>
          <Section title="備援">
            <Group>
              <Row
                label="樹莓派離線時由插座接手"
                hint={`寫一份到插座裡；平常由樹莓派執行，樹莓派離線時插座照樣會做（只到分鐘${d.action === "off" && d.restore_at ? "；「之後再打開」不會寫進插座" : ""}）`}
                htmlFor="bk"
              >
                <Switch id="bk" checked={!!d.backup} onCheckedChange={(v) => up({ backup: v })} />
              </Row>
              {(showBackup || rules || (d.backup && d.action === "on" && d.duration_s && d.duration_s % 60)) ? (
                <div className="space-y-1.5 px-4 py-3">
                  {showBackup && (b!.ok === b!.total
                    ? <StatLine icon={CheckCircle2} tone="ok">{b!.total} 個插座都寫好了</StatLine>
                    : b!.issues.map((i, k) => <StatLine key={k} icon={i.pending ? Clock : AlertCircle} tone={i.pending ? undefined : "bad"}>{i.plug}：{i.reason}</StatLine>))}
                  {rules && <StatLine icon={PlugZap}>插座裡：{rules}</StatLine>}
                  {d.backup && d.action === "on" && !!d.duration_s && d.duration_s % 60 !== 0 && (
                    <StatLine icon={AlertCircle}>插座只到分鐘：樹莓派離線時會在下一個整分鐘才關，最多多開 {60 - (d.duration_s % 60)} 秒</StatLine>
                  )}
                </div>
              ) : null}
            </Group>
          </Section>
        </div>

        <div className="min-w-0 space-y-5">
          <Section title="要做什麼">
            <Segmented label="要做什麼" value={d.action} onChange={(v) => up({ action: v })} options={[["off", "關閉插座"], ["on", "打開插座"], ["scene", "執行情境"]]} />
            {d.action === "off" && (
              <Group>
                <Row label="之後再打開" hint="只打開被這個排程關掉的；本來就關著的不會被打開" htmlFor="rs">
                  <Switch id="rs" checked={!!d.restore_at} onCheckedChange={(v) => up({ restore_at: v ? "07:00:00" : null })} />
                </Row>
                {d.restore_at && (
                  <div className="space-y-2 px-4 py-3">
                    <ClockPicker value={d.restore_at} onChange={(t) => up({ restore_at: t })} />
                    <p className="text-xs text-muted-foreground">{mode === "clock" && d.restore_at <= d.time ? "隔天" : "當天"}這個時間打開</p>
                  </div>
                )}
              </Group>
            )}
            {d.action === "on" && (
              <Group>
                <Row label="開多久後自動關閉" hint="例如澆水開 50 秒；插座有設「最長開啟時間」的話，以比較短的為準" htmlFor="du">
                  <Switch id="du" checked={!!d.duration_s} onCheckedChange={(v) => up({ duration_s: v ? 60 : null })} />
                </Row>
                {!!d.duration_s && (
                  <div className="px-4 py-3">
                    <DurationPicker value={d.duration_s} onChange={(v) => up({ duration_s: v || 1 })} />
                  </div>
                )}
              </Group>
            )}
          </Section>
          <Section title={d.action === "scene" ? "哪個情境" : d.action === "on" ? "打開哪些插座" : "關閉哪些插座"}>
            {d.action === "scene" ? (
              scenes.length ? (
                <div className="flex flex-wrap gap-2">
                  {scenes.map((sc) => {
                    const I = mdiIcon(sc.icon);
                    return (
                      <ChoiceChip key={sc.id} selected={d.scene === sc.id} onClick={() => up({ scene: sc.id })}>
                        {d.scene !== sc.id && <I className="size-4" />}{sc.name}
                      </ChoiceChip>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">還沒有情境，先到舊版的「編輯」新增一個。</p>
              )
            ) : (
              <PlugPicker
                selected={d.plugs}
                onChange={(ids) => up({ plugs: ids })}
                disabled={(p) => (d.action === "off" && p.keep_on ? "常開的插座不會被關" : false)}
              />
            )}
          </Section>
        </div>
      </div>

      <div className="sticky -bottom-6 -mx-6 -mb-6 flex flex-wrap items-center gap-2 border-t bg-background/95 px-6 py-3 backdrop-blur max-md:-mx-4 max-md:px-4">
        {err && <p role="alert" className="w-full text-sm text-destructive">{err}</p>}
        {id ? (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" className="text-destructive hover:bg-destructive/10 hover:text-destructive" disabled={!!busy}>
                {busy === "delete" ? <Loader2 className="animate-spin" /> : <Trash2 />}刪除排程
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>刪除這條排程？</AlertDialogTitle>
                <AlertDialogDescription>寫進插座的備援也會一起清掉，不能復原。</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>取消</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={remove}>刪除</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : (
          <Button variant="ghost" onClick={onClose}>取消</Button>
        )}
        <Button className="ml-auto h-11 min-w-28" onClick={save} disabled={!!busy}>
          {busy === "save" && <Loader2 className="animate-spin" />}儲存
        </Button>
      </div>
    </div>
  );
}

