import { useEffect, useState } from "react";
import { ArrowRightLeft, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ClockPicker } from "@/components/duration-picker";
import { deviceIcon } from "@/components/icons";
import { Sheet } from "@/components/responsive-sheet";
import { DayPicker, Segmented, SunOffset, TimeModePicker, daysText, kasaDays, minText, toKasaWday, useRuleMin } from "@/components/schedule-bits";
import { Group, Row, Section } from "@/components/settings-bits";
import { api } from "@/lib/api";
import { useHub } from "@/lib/hub";
import type { KasaRule, TimeMode } from "@/lib/types";

export type KasaOpen = { pid: string; rule: KasaRule } | null;
export const ruleMatch = (r: KasaRule) => ({ sact: r.sact, opt: r.opt, val: r.val, wday: r.wday });

// 轉成家庭中控的排程（按鈕＋確認）
export function useAdopt() {
  return async (pid: string, r: KasaRule) => {
    try {
      await api("POST", "/api/kasa-rules/adopt", { plug: pid, match: ruleMatch(r), enabled: !!r.enable });
      toast.success("已轉成家庭中控的排程");
      return true;
    } catch (e) {
      toast.error("沒有成功", { description: (e as Error).message });
      return false;
    }
  };
}

interface Draft { sact: number; mode: TimeMode; offset: number; time: string; days: number[]; enable: boolean }

// 插座裡（Kasa App 設的）排程：直接改插座裡的設定
export function KasaSheet({ open, onClose }: { open: KasaOpen; onClose: () => void }) {
  const { state } = useHub();
  const ruleMin = useRuleMin();
  const p = open ? state?.plugs.find((x) => x.id === open.pid) : undefined;
  const [d, setD] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const adopt = useAdopt();
  useEffect(() => {
    if (!open) return setD(null);
    const r = open.rule;
    setErr("");
    setD({ sact: r.sact, mode: (["clock", "sunrise", "sunset"] as TimeMode[])[r.opt] || "clock", offset: r.opt ? r.val : 0, time: minText(r.opt ? ruleMin(r) : r.val), days: kasaDays(r.wday), enable: !!r.enable });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const I = p ? deviceIcon(p.name) : null;
  const up = (x: Partial<Draft>) => {
    setErr("");
    setD((v) => (v ? { ...v, ...x } : v));
  };
  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success(ok);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const save = () => {
    if (!open || !d) return;
    if (!d.days.length) return setErr("請至少選一天");
    const [h, m] = d.time.split(":").map(Number);
    const opt = { clock: 0, sunrise: 1, sunset: 2 }[d.mode];
    run("save", () => api("PUT", "/api/kasa-rules", { plug: open.pid, match: ruleMatch(open.rule), set: { enable: d.enable, sact: d.sact, opt, val: opt ? d.offset : h * 60 + m, wday: toKasaWday(d.days) } }), "已更新插座裡的排程");
  };

  return (
    <Sheet
      open={!!open && !!p && !!d}
      onOpenChange={(v) => !v && onClose()}
      title="插座內建排程"
      description={p ? `${p.name}・用 Kasa App 設的，存在插座裡` : undefined}
      icon={I ? <I /> : undefined}
      wide
    >
      {open && p && d && (
        <div className="space-y-5">
          <Group>
            <Row label="啟用" htmlFor="k-en"><Switch id="k-en" checked={d.enable} onCheckedChange={(v) => up({ enable: v })} /></Row>
          </Group>
          <Section title="什麼時候・插座的排程只到分鐘">
            <TimeModePicker value={d.mode} onChange={(v) => up({ mode: v })} />
            {d.mode === "clock" ? <ClockPicker seconds={false} value={d.time} onChange={(t) => up({ time: t })} /> : <SunOffset mode={d.mode} offset={d.offset} onChange={(v) => up({ offset: v })} />}
          </Section>
          <Section title={`哪幾天・${daysText(d.days)}`}>
            <DayPicker days={d.days} onChange={(v) => up({ days: v })} />
          </Section>
          <Section
            title="要做什麼"
            note={<>改的是插座裡的設定，Kasa App 也會看到一樣的內容。插座自己執行，不需要樹莓派，但也<b>不會</b>遵守鎖定、常開這些防呆設定。</>}
          >
            <Segmented label="要做什麼" value={d.sact} onChange={(v) => up({ sact: v })} options={[[1, "打開"], [0, "關閉"]]} />
          </Section>
          <Group>
            <Row label="改由家庭中控管理" hint="轉成家庭中控的排程：可以設到秒、套用防呆和最長開啟時間，樹莓派離線時一樣由插座接手">
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" disabled={!!busy}>{busy === "adopt" ? <Loader2 className="animate-spin" /> : <ArrowRightLeft />}轉換</Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>轉成家庭中控的排程？</AlertDialogTitle>
                    <AlertDialogDescription>會建立一條一樣的家庭中控排程，並刪掉插座裡原本這條（Kasa App 也會看不到它）。</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>取消</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={async () => {
                        setBusy("adopt");
                        if (await adopt(open.pid, open.rule)) onClose();
                        setBusy(null);
                      }}
                    >
                      轉換
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </Row>
          </Group>

          <div className="sticky -bottom-6 -mx-6 -mb-6 flex flex-wrap items-center gap-2 border-t bg-background/95 px-6 py-3 backdrop-blur max-md:-mx-4 max-md:px-4">
            {err && <p role="alert" className="w-full text-sm text-destructive">{err}</p>}
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" className="text-destructive hover:bg-destructive/10 hover:text-destructive" disabled={!!busy}>
                  {busy === "delete" ? <Loader2 className="animate-spin" /> : <Trash2 />}刪除
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>刪除這條插座內建排程？</AlertDialogTitle>
                  <AlertDialogDescription>插座裡的這條排程會被刪掉，Kasa App 也會看不到它，不能復原。</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={() => run("delete", () => api("DELETE", "/api/kasa-rules", { plug: open.pid, match: ruleMatch(open.rule) }), "已刪除")}>刪除</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <Button className="ml-auto h-11 min-w-28" onClick={save} disabled={!!busy}>
              {busy === "save" && <Loader2 className="animate-spin" />}儲存
            </Button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
