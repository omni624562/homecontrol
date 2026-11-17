# 插座 App（不用 Home Assistant）

樹莓派上的小伺服器加一個手機網頁 App，直接在區網控制 TP-Link Kasa／Tapo 插座：不用帳號、不經過雲端、不用 Home Assistant。

<p>
  <img src="../docs/app-light.png" width="300" alt="插座 App">
  <img src="../docs/app-dark.png" width="300" alt="插座 App 深色模式">
</p>

## 功能

- **自動找插座**：每分鐘在區網找一次，新插座自動出現；換了 IP 也會跟著更新。多孔排插（HS107、KP303）每一孔各算一個
- **開關**：點插座卡片。右上角 ⋯ 改名稱、房間、常開、夜間關閉、估算瓦數
- **房間**：「分配房間」一個一個點選；或拖拉插座到別的房間（手機按住一下再拖）；「整理房間」模式下可以直接拖、拉房間右上角的把手排房間順序；插座拖到另一個插座的左／右半邊就排在它前／後
- **全部關閉／房間全關**：按一次就關，提示條上可以「復原」。常開的插座不會被關
- **夜間排程**：晚上關掉選好的插座，早上只打開晚上被排程關掉的
- **用電與電費**：有計量的插座用實際用電；沒有計量的填上瓦數就用「開著的時間 × 瓦數」估算。電費用台電累進電價（`plughub/tariff.py`），依家裡每月用電落在哪一級計算
- **手機通知**（選用）：插座斷線超過 10 分鐘、功率過高 1 分鐘，用 [ntfy](https://ntfy.sh) 推播。手機裝 ntfy App、訂閱一個只有你知道的主題名稱，填到 App 的「設定 → 手機通知」
- **加入主畫面**：iPhone 用 Safari 開 → 分享 →「加入主畫面」；Android 用 Chrome 開 → ⋮ →「加到主畫面」。之後就像一般 App 一樣全螢幕打開

## 安裝

樹莓派上（需要 Docker）：

```bash
cd app
docker compose up -d --build
```

手機打開 `http://樹莓派的IP:8100`。資料（房間、設定、每天用電）存在 `app/data/`，備份這個資料夾就好。

更新程式：`git pull` 之後再執行一次 `docker compose up -d --build`。

## 手機連不上？

先在手機瀏覽器開 `http://樹莓派的IP:8100`（是 `http://`，不是 `https://`）：

- 打不開：手機和樹莓派不在同一個網段（訪客 Wi-Fi、另一台路由器），或 Wi-Fi 開了「AP 隔離」。把手機換到主要的 Wi-Fi，或在路由器關掉隔離
- 在外面也想用：樹莓派和手機都裝 [Tailscale](https://tailscale.com)（免費），手機用 `http://樹莓派的Tailscale位址:8100` 開

## 檔案

| 檔案 | 內容 |
| --- | --- |
| `plughub/hub.py` | 找插座、更新狀態、開關、累計用電、夜間排程、通知 |
| `plughub/main.py` | 網頁伺服器和 API |
| `plughub/store.py` | 設定（`data/store.json`）和每天用電（`data/energy.db`） |
| `plughub/tariff.py` | 台電累進電價表 |
| `plughub/notify.py` | ntfy 通知 |
| `plughub/static/` | 手機網頁 App（`app.js`）、圖示、加入主畫面用的設定 |

## API

| 方法 | 路徑 | 內容 |
| --- | --- | --- |
| GET | `/api/state` | 全部狀態 |
| GET | `/api/events` | 狀態一有變動就推送（Server-Sent Events） |
| POST | `/api/plugs/{id}/power` | `{"on": true}` 開／關 |
| PATCH | `/api/plugs/{id}` | `name`、`room`、`keep_on`、`night`、`watts` |
| POST | `/api/off` | `{"room": "...", "standby_only": false}` 關閉並記住；`/api/restore` 復原 |
| POST／PATCH／DELETE | `/api/rooms`、`/api/rooms/{id}` | 新增、改名、刪除房間 |
| POST | `/api/order` | `{"plugs": [...], "rooms": [...]}` 順序 |
| PUT | `/api/schedule`、`/api/settings` | 夜間排程、電價與門檻、ntfy 主題 |
| POST | `/api/discover` | 立刻重新找插座 |
