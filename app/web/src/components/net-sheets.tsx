import { useEffect, useState } from "react";
import { Loader2, Plug as PlugIcon, Trash2, User } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet } from "@/components/responsive-sheet";
import { ChoiceChip } from "@/components/schedule-bits";
import { LocateSection } from "@/components/locate";
import { Group, Row, Section, Value } from "@/components/settings-bits";
import { api } from "@/lib/api";
import { useHub } from "@/lib/hub";
import { KIND, devKind, netAgo, netWhere, type NetData } from "@/lib/net";

const Footer = ({ children }: { children: React.ReactNode }) => (
  <div className="sticky -bottom-6 -mx-6 -mb-6 flex flex-wrap items-center gap-2 border-t bg-background/95 px-6 py-3 backdrop-blur max-md:-mx-4 max-md:px-4">{children}</div>
);

// 標題列右邊的狀態標籤
function StatePill({ on, text }: { on: boolean; text: string }) {
  return (
    <span className={`inline-flex h-8 max-w-56 items-center gap-1.5 rounded-full border bg-background px-3 text-sm font-medium text-muted-foreground ${on ? "border-emerald-300 text-emerald-800 dark:border-emerald-500/40 dark:text-emerald-300" : ""}`}>
      <i className={`size-2 shrink-0 rounded-full ${on ? "bg-emerald-500" : "bg-neutral-400"}`} />
      <span className="truncate">{text}</span>
    </span>
  );
}

// 一台網路裝置：取名字、是誰的、放到訊號地圖
export function NetDevSheet({ mac, net, onClose, onSaved }: { mac: string | null; net: NetData | null; onClose: () => void; onSaved: (n?: NetData) => void }) {
  const { state } = useHub();
  const c = mac ? net?.clients.find((x) => x.mac === mac) : undefined;
  const [label, setLabel] = useState("");
  const [map, setMap] = useState(false);
  const [trusted, setTrusted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!c) return;
    setLabel(c.label || "");
    setMap(c.map);
    setTrusted(!!c.trusted);
    setErr("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mac]);
  if (!c || !net) return <Sheet open={false} onOpenChange={() => onClose()} title="">{null}</Sheet>;
  const people = state?.people || [];
  const canMap = !c.plug && !c.wired;
  const node = net.nodes.find((x) => x.mac === c.node);
  const where = netWhere(c);
  const K = KIND[devKind(c)];
  const I = c.plug ? PlugIcon : K.icon;

  const togglePerson = async (pid: string) => {
    const x = people.find((p) => p.id === pid);
    if (!x) return;
    const macs = x.macs.includes(c.mac) ? x.macs.filter((m) => m !== c.mac) : [...x.macs, c.mac];
    try {
      await api("PUT", `/api/people/${pid}`, { name: x.name, macs });
      onSaved();
    } catch (e) {
      toast.error("沒有成功", { description: (e as Error).message });
    }
  };
  const same = async (sub: string, target: string | null) => {
    try {
      const n = await api<NetData>("PATCH", `/api/net/devices/${encodeURIComponent(sub)}`, { same_as: target });
      toast.success(target ? "合成一台了" : "拆開了");
      onSaved(n);
      if (target) onClose();
    } catch (e) {
      toast.error("沒有成功", { description: (e as Error).message });
    }
  };
  const others = net.clients.filter((x) => x.mac !== c.mac && !x.plug).sort((a, b) => a.name.localeCompare(b.name));
  const save = async () => {
    setBusy(true);
    try {
      const body: { label: string | null; map?: boolean; trusted?: boolean } = { label: label.trim() || null };
      if (canMap) body.map = map;
      if (!c.plug) body.trusted = trusted;
      const n = await api<NetData>("PATCH", `/api/net/devices/${encodeURIComponent(c.mac)}`, body);
      toast.success(body.map && !c.map ? "已加到訊號地圖：到地圖的「編輯」把它擺到實際的位置" : "已儲存");
      onSaved(n);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open onOpenChange={(v) => !v && onClose()} title={c.name}
      description={c.plug ? `插座：${c.plug}` : c.vendor || c.guess || undefined}
      icon={<I />}
      wide
      aside={<StatePill on={c.online} text={c.online ? `連線中・${c.wired ? "有線" : c.band || "Wi-Fi"}` : "沒連線"} />}
    >
      <form className="space-y-5" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <Section title="名字">
          <Input value={label} maxLength={30} placeholder={c.guess || c.router_name || "例如：客廳電視、爸爸的手機"} aria-label="名字" onChange={(e) => setLabel(e.target.value)} className="h-11" />
        </Section>
        {people.length > 0 && !c.plug && (
          <Section title="這是誰的手機・用來判斷誰在家">
            <div className="flex flex-wrap gap-2">
              {people.map((x) => (
                <ChoiceChip key={x.id} selected={x.macs.includes(c.mac)} onClick={() => togglePerson(x.id)}>{x.name}</ChoiceChip>
              ))}
            </div>
          </Section>
        )}
        {!c.plug && (
          <Group>
            <Row
              label="不用配對"
              hint={c.person ? `${c.person}的手機（登記在「誰在家」）本來就自動認得，不用打開` : "家裡的平板、電腦：從這台打開家庭中控不用輸入配對碼。只打開你自己的裝置"}
              htmlFor="nd-trusted"
            >
              <Switch id="nd-trusted" checked={trusted || !!c.person} disabled={!!c.person} onCheckedChange={setTrusted} />
            </Row>
          </Group>
        )}
        {canMap && (
          <Group>
            <Row label="放到訊號地圖" hint="用路由器量到的它的訊號偵測附近的動靜。適合不會移動的裝置：電視、電腦、智慧音箱；手機會被帶著走，不適合。" htmlFor="nd-map">
              <Switch id="nd-map" checked={map} onCheckedChange={setMap} />
            </Row>
          </Group>
        )}
        {!c.plug && (
          <Section title="同一台裝置（同一台電腦用有線、無線會是兩個 MAC）">
            {c.links ? (
              <div className="divide-y rounded-xl border">
                {c.links.map((l) => (
                  <div key={l.mac} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{l.wired ? "有線" : l.band || "Wi-Fi"}</span>
                      <span className="text-muted-foreground">・{l.online ? `連線中${l.ip ? `・${l.ip}` : ""}` : l.seen ? `最後看到 ${netAgo(l.seen, net.now)}` : "沒連線"}</span>
                      <span className="block truncate text-xs text-muted-foreground tabular-nums">{l.mac}</span>
                    </span>
                    {!l.main && <Button type="button" variant="ghost" size="sm" onClick={() => same(l.mac, null)}>拆開</Button>}
                  </div>
                ))}
              </div>
            ) : (
              <Select value="" onValueChange={(v) => same(c.mac, v)}>
                <SelectTrigger className="h-11 w-full bg-background" aria-label="跟哪一台是同一台"><SelectValue placeholder="跟哪一台是同一台？" /></SelectTrigger>
                <SelectContent>
                  {others.map((x) => (
                    <SelectItem key={x.mac} value={x.mac}>{x.name}・{x.wired ? "有線" : x.band || "Wi-Fi"}{x.ip ? `・${x.ip}` : ""}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Section>
        )}
        <Group>
          <Row label="IP"><Value>{c.ip || "—"}</Value></Row>
          <Row label="MAC"><Value>{c.mac}</Value></Row>
          {c.guess && <Row label="自動辨識" hint="樹莓派在家裡網路直接問它的（網頁標題、憑證上的公司），可能不準"><Value>{c.guess}</Value></Row>}
          <Row label="廠商"><Value>{c.vendor || "—"}</Value></Row>
          <Row label="路由器上的名字"><Value>{c.router_name || "—"}</Value></Row>
          <Row label="連在">
            <Value>{c.online ? `${node ? `${node.model}（${node.main ? "主路由器" : "節點"}）` : "—"}${where ? `・${where}` : ""}` : `沒連線${c.seen ? `・最後看到 ${netAgo(c.seen, net.now)}` : ""}`}</Value>
          </Row>
          <Row label="第一次看到"><Value>{c.first ? netAgo(c.first, net.now) : "—"}</Value></Row>
        </Group>
        <Footer>
          {err && <p role="alert" className="w-full text-sm text-destructive">{err}</p>}
          <Button type="button" variant="ghost" onClick={onClose}>取消</Button>
          <Button type="submit" className="ml-auto h-11 min-w-28" disabled={busy}>{busy && <Loader2 className="animate-spin" />}儲存</Button>
        </Footer>
      </form>
    </Sheet>
  );
}

// 家人：名字、他的手機（手錶）；open = 家人 id，"" 是新增
export function PersonSheet({ open, net, onClose, onSaved }: { open: string | null; net: NetData | null; onClose: () => void; onSaved: () => void }) {
  const { state } = useHub();
  const isNew = open === "";
  const person = open ? state?.people.find((x) => x.id === open) : undefined;
  const [name, setName] = useState("");
  const [macs, setMacs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    setName(person?.name || "");
    setMacs([...(person?.macs || [])]);
    setErr("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // 可以選的：現在連著 Wi-Fi、不是插座的裝置，加上已經選的
  const cands = (net?.clients || []).filter((c) => macs.includes(c.mac) || (c.online && !c.plug && !c.wired));
  const save = async () => {
    const n = name.trim();
    if (!n) return setErr("請輸入名字");
    setBusy(true);
    try {
      if (person) await api("PUT", `/api/people/${person.id}`, { name: n, macs });
      else await api("POST", "/api/people", { name: n, macs });
      toast.success(person ? "已儲存" : `已新增「${n}」`);
      onSaved();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!person) return;
    try {
      await api("DELETE", `/api/people/${person.id}`);
      toast.success(`已刪除「${person.name}」`);
      onSaved();
      onClose();
    } catch (e) {
      toast.error("沒有成功", { description: (e as Error).message });
    }
  };
  return (
    <Sheet
      open={open !== null && (isNew || !!person)}
      onOpenChange={(v) => !v && onClose()}
      title={isNew ? "新增家人" : person?.name || ""}
      description={person ? `${person.macs.length} 台裝置` : undefined}
      icon={<User />}
      wide
      aside={person ? <StatePill on={!!person.home} text={person.home ? "在家" : "出門"} /> : undefined}
    >
      <form className="space-y-5" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <Section title="名字">
          <Input autoFocus={isNew} value={name} maxLength={20} placeholder="例如：爸爸" aria-label="名字" onChange={(e) => { setName(e.target.value); setErr(""); }} className="h-11" />
        </Section>
        <Section title="他的手機" note="選一到兩支；不知道是哪一支，可以先把手機的 Wi-Fi 關掉再打開，看哪一個消失又出現。">
          {cands.length ? (
            <div className="flex flex-wrap gap-2">
              {cands.map((c) => {
                const on = macs.includes(c.mac);
                const other = !on && c.person && c.person !== person?.name ? `（${c.person}）` : "";
                const K = KIND[devKind(c)].icon;
                return (
                  <ChoiceChip key={c.mac} selected={on} onClick={() => setMacs(on ? macs.filter((m) => m !== c.mac) : [...macs, c.mac])}>
                    {!on && <K className="size-4" />}{c.name}{other}
                  </ChoiceChip>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{net ? "現在沒有連著 Wi-Fi 的裝置" : "讀取中…"}</p>
          )}
        </Section>
        {person && <LocateSection personId={person.id} />}
        <Footer>
          {err && <p role="alert" className="w-full text-sm text-destructive">{err}</p>}
          {person ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button type="button" variant="ghost" className="text-destructive hover:bg-destructive/10 hover:text-destructive"><Trash2 />刪除</Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>刪除「{person.name}」？</AlertDialogTitle>
                  <AlertDialogDescription>只是不再判斷他在不在家，手機本身不受影響。</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={remove}>刪除</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : (
            <Button type="button" variant="ghost" onClick={onClose}>取消</Button>
          )}
          <Button type="submit" className="ml-auto h-11 min-w-28" disabled={busy}>{busy && <Loader2 className="animate-spin" />}{person ? "儲存" : "新增"}</Button>
        </Footer>
      </form>
    </Sheet>
  );
}

