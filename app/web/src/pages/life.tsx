import { PageHeader } from "@/components/app-shell";
import { LifeSheet } from "@/components/life-sheet";
import { WeatherSheet } from "@/components/weather-sheet";
import { useHub } from "@/lib/hub";

const noop = () => {};

// 生活：天氣、垃圾車、公車、YouBike、停水停電攤開在一頁（首頁上方的小標籤點開是同樣的內容）
export function LifePage() {
  const { state } = useHub();
  const L = state?.calendar.local;
  return (
    <>
      <PageHeader title="生活" sub={L?.place ? `${L.place}・政府開放資料，每幾分鐘更新` : "政府開放資料，每幾分鐘更新"} />
      <div className="mx-auto grid max-w-[112rem] grid-cols-[minmax(0,1fr)] items-start gap-4 px-4 py-4 sm:px-6 lg:grid-cols-2 lg:px-8 2xl:grid-cols-3 [&>*]:min-w-0">
        <div className="lg:col-span-2 2xl:col-span-1 2xl:row-span-2"><WeatherSheet inline open onClose={noop} /></div>
        <LifeSheet inline open onClose={noop} topic="bike" />
        <LifeSheet inline open onClose={noop} topic="bus" />
        <LifeSheet inline open onClose={noop} topic="garbage" />
        <LifeSheet inline open onClose={noop} topic="outage" />
      </div>
    </>
  );
}
