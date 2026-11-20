import { useCallback, useEffect, useRef, useState } from "react";
import { Pause, Wifi } from "lucide-react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { Sheet } from "@/components/responsive-sheet";
import { Segmented } from "@/components/schedule-bits";
import { Group, Row } from "@/components/settings-bits";
import { api } from "@/lib/api";
import { fmt, pad2 } from "@/lib/format";
import { cn } from "@/lib/utils";

type Range = "1h" | "24h" | "7d" | "30d";
interface Sensing {
  enabled: boolean;
  minutes: number;
  start: number;
  bucket?: number;
  since?: number | null;
  samples?: number;
  active: string[];
  devices: { name: string; now: number | null; cols: { motion: number | null; rssi: number | null }[] }[];
}

const CAP = 3; // 擾動 3 dB 以上算最深

// Wi-Fi 感測（實驗）：每台插座 × 一段時間的訊號擾動熱力圖
export function SenseSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [range, setRange] = useState<Range>("1h");
  const [d, setD] = useState<Sensing | null>(null);
  const [tip, setTip] = useState<string | null>(null);
  // 手機上放不下：捲到最右邊（最近）
  const scroller = useRef<HTMLDivElement>(null);
  const ready = !!d;
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [ready, range]);
  const load = useCallback(() => {
    api<Sensing>("GET", `/api/sensing?range=${range}`).then(setD).catch(() => {});
  }, [range]);
  useEffect(() => {
    if (!open) return;
    setD(null);
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [open, load]);

  const toggle = async (on: boolean) => {
    setD((x) => (x ? { ...x, enabled: on } : x));
    try {
      await api("PUT", "/api/sensing", { enabled: on });
    } catch (e) {
      toast.error("沒有成功", { description: (e as Error).message });
      load();
    }
  };

  let body = <div className="py-16 text-center text-muted-foreground">讀取中…</div>;
  if (d) {
    const step = d.bucket || 60;
    const at = (i: number) => {
      const t = new Date((d.start + i * step) * 1000);
      const hm = `${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
      const md = `${t.getMonth() + 1}/${t.getDate()}`;
      return range === "30d" ? md : range === "7d" ? `${md} ${hm}` : hm;
    };
    const every = { "1h": 10, "24h": 8, "7d": 6, "30d": 5 }[range];
    const unit = { "1h": "一分鐘", "24h": "30 分鐘", "7d": "4 小時", "30d": "一天" }[range];
    const title = { "1h": `最近 ${d.minutes} 分鐘`, "24h": "最近 24 小時", "7d": "最近 7 天", "30d": "最近 30 天" }[range];
    const since = d.since && range !== "1h" ? new Date(d.since * 1000) : null;
    body = (
      <div className="space-y-5">
        <div className="space-y-3 rounded-xl border p-4">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="flex-1 font-semibold">{title}</h3>
            <div className="w-full sm:w-80"><Segmented label="期間" value={range} onChange={setRange} options={[["1h", "1 小時"], ["24h", "24 小時"], ["7d", "7 天"], ["30d", "30 天"]]} /></div>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5" aria-hidden>
              安靜{[0.15, 0.4, 0.7, 1].map((a) => <i key={a} className="size-3.5 rounded-[3px] bg-orange-500" style={{ opacity: a }} />)}擾動大
            </span>
            {since && <span>從 {since.getMonth() + 1}/{since.getDate()} 開始有長期紀錄</span>}
          </div>
          <div className="min-h-6 text-sm tabular-nums text-muted-foreground" aria-live="polite">
            <span className={cn(tip && "font-medium text-foreground")}>{tip || `每一格是${unit}（那段時間裡最大的擾動），顏色越深擾動越大・滑過看數字`}</span>
          </div>
          <div ref={scroller} className="overflow-x-auto" onMouseLeave={() => setTip(null)}>
            <div className="grid min-w-[36rem] items-center gap-[2px]" style={{ gridTemplateColumns: `minmax(4.5rem, 8rem) repeat(${d.minutes}, minmax(0, 1fr)) 2.75rem` }}>
              <span className="sticky left-0 z-10 h-full bg-background" />
              {Array.from({ length: d.minutes }, (_, i) => (
                <span key={i} className="overflow-visible text-[10px] whitespace-nowrap text-muted-foreground">{i % every === 0 && i < d.minutes - every / 2 ? (range === "7d" ? at(i).split(" ")[0] : at(i)) : ""}</span>
              ))}
              <span className="text-center text-[11px] text-muted-foreground">現在</span>
              {(d.devices || []).map((dev) => (
                <SenseRow key={dev.name} dev={dev} at={at} onTip={setTip} />
              ))}
            </div>
          </div>
        </div>
        <Group>
          <Row label="記錄訊號" hint="每 2 秒讀一次每台插座的訊號強度；細的資料留 1 小時，每分鐘的摘要留 30 天（都存在樹莓派上）；只讀取，不控制任何東西" htmlFor="sense-en">
            <Switch id="sense-en" checked={d.enabled} onCheckedChange={toggle} />
          </Row>
        </Group>
        <div className="space-y-1 text-sm leading-relaxed text-muted-foreground">
          <p><b className="text-foreground">怎麼測試：</b>在某台插座附近走動 1～2 分鐘，再看那一列有沒有變深。</p>
          <p><b className="text-foreground">限制：</b>插座只回報訊號強度（一個數字），只能偵測走動，偵測不到靜止的人；路由器、其他 Wi-Fi、微波爐也會造成擾動。要可靠地偵測有沒有人，建議用毫米波雷達感測器。</p>
        </div>
      </div>
    );
  }
  return (
    <Sheet
      open={open}
      onOpenChange={(v) => !v && onClose()}
      title={<span className="inline-flex items-center gap-2">Wi-Fi 感測<span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">實驗</span></span>}
      description={<Status d={d} />}
      icon={d && d.enabled && d.active.length ? <Wifi className="text-amber-600" /> : d && !d.enabled ? <Pause /> : <Wifi />}
      wide="xl"
    >
      {body}
    </Sheet>
  );
}

// 標題下面一行：現在的狀態（固定在上面，捲動也看得到）
function Status({ d }: { d: Sensing | null }) {
  if (!d) return <>用插座的訊號擾動，猜哪裡有人在走動</>;
  if (!d.enabled) return <>記錄已暫停・打開下面的「記錄訊號」開始記錄</>;
  if (d.active.length)
    return (
      <span className="font-medium text-amber-700 dark:text-amber-400">
        最近 30 秒有動靜：{d.active.join("、")} 附近
      </span>
    );
  return <>目前沒有偵測到動靜・{d.samples ? `已記錄 ${fmt(d.samples)} 筆` : "剛開始記錄，等幾分鐘"}</>;
}

function SenseRow({ dev, at, onTip }: { dev: Sensing["devices"][number]; at: (i: number) => string; onTip: (t: string) => void }) {
  return (
    <>
      <span title={dev.name} className="sticky left-0 z-10 h-full truncate bg-background pr-2 text-sm leading-6">{dev.name}</span>
      {dev.cols.map((c, i) => {
        const m = c.motion;
        const t = m == null ? `${dev.name}・${at(i)}：沒有資料` : `${dev.name}・${at(i)}：擾動 ${fmt(m, 1)}・訊號 ${fmt(c.rssi, 0)} dBm`;
        return (
          <i
            key={i}
            onMouseEnter={() => onTip(t)}
            onTouchStart={() => onTip(t)}
            className={cn("block h-5 rounded-[2px]", m == null ? "bg-transparent" : m > 0.15 ? "bg-orange-500" : "bg-muted")}
            style={m != null && m > 0.15 ? { opacity: Math.max(0.12, Math.min(1, m / CAP)) } : undefined}
          />
        );
      })}
      <span className={cn("text-center text-sm tabular-nums", dev.now != null && dev.now >= 1 && "font-semibold text-orange-600")}>{dev.now == null ? "—" : fmt(dev.now, 1)}</span>
    </>
  );
}
