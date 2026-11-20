import { PageHeader } from "@/components/app-shell";
import { LifeSheet } from "@/components/life-sheet";
import { AlertsCard } from "@/components/alerts";
import { WeatherSheet } from "@/components/weather-sheet";
import { useHub, useMedia } from "@/lib/hub";

const noop = () => {};

// 生活：天氣、YouBike、公車、垃圾車、停水停電攤開在一頁（首頁上方的小標籤點開是同樣的內容）
// 每一直欄各自往下排，高的卡片不會在旁邊留下空白
export function LifePage() {
  const { state } = useHub();
  const L = state?.calendar.local;
  const wide3 = useMedia("(min-width: 1536px)");
  const wide2 = useMedia("(min-width: 1024px)");
  const weather = <WeatherSheet inline open onClose={noop} />;
  const alerts = <AlertsCard A={state?.calendar.alerts} />;
  const bike = <LifeSheet inline open onClose={noop} topic="bike" />;
  const bus = <LifeSheet inline open onClose={noop} topic="bus" />;
  const garbage = <LifeSheet inline open onClose={noop} topic="garbage" />;
  const outage = <LifeSheet inline open onClose={noop} topic="outage" />;
  const col = (...xs: React.ReactNode[]) => <div className="flex min-w-0 flex-col gap-4">{xs.map((x, i) => <div key={i}>{x}</div>)}</div>;
  return (
    <>
      <PageHeader title="生活" sub={L?.place ? `${L.place}・政府開放資料，每幾分鐘更新` : "政府開放資料，每幾分鐘更新"} />
      <div className="mx-auto max-w-[112rem] px-4 py-4 sm:px-6 lg:px-8">
        {wide3 ? (
          <div className="grid grid-cols-3 items-start gap-4">{col(alerts, weather)}{col(bike, garbage)}{col(bus, outage)}</div>
        ) : wide2 ? (
          <div className="flex flex-col gap-4"><div className="grid grid-cols-2 items-start gap-4">{col(alerts, bike, garbage)}{col(weather, bus, outage)}</div></div>
        ) : (
          col(alerts, weather, bike, bus, garbage, outage)
        )}
      </div>
    </>
  );
}
