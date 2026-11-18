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

## Google Home（Matter，不經過雲端）

樹莓派會同時跑一個 [Matterbridge](https://github.com/Luligu/matterbridge)，把每個插座變成 Matter 插座。Google Home 在家裡直接控制，不經過 TP-Link 雲端，斷網時語音和 Google Home App 也能用。Apple Home 和 Alexa 也可以用同樣的方式加入。

需要一台 Google 中樞裝置：Nest Mini、Nest Audio、Nest Hub、Google TV Streamer 或 Chromecast with Google TV。

配對（只要做一次）：

1. 打開插座 App，捲到最下面「**Google Home**」，上面有配對 QR code 和配對碼（配對好之後會改成顯示「已連上」）
2. 手機或平板打開 **Google Home** App →「＋」→「裝置」→「新裝置」→ 選家庭 →「Matter 裝置」
3. 掃 QR code（或輸入畫面上的 11 位數配對碼）。出現「未經認證的裝置」時選「仍要繼續」
4. 所有插座會一次加進來，在 Google Home 裡把它們分到房間

之後：

- 說「Hey Google，關掉立燈」，或在 Google Home 的「自動化」裡設定
- 插座 App 和 Google Home 的開關狀態會互相同步；新找到的插座也會自動出現在 Google Home
- Google Home 裡的名稱和房間是另外存的，配對後在插座 App 改名不會影響 Google Home。Matter 的名稱最多 32 bytes，超過的中文名稱會被截短，到 Google Home 裡改回來就好
- 確定 Matter 能用之後，可以在 Google Home 移除原本的「TP-Link Kasa」連結，以免每個插座出現兩次

注意：配對時手機要能連到樹莓派（同一個 Wi-Fi、沒有 AP 隔離）。如果手機連不上插座 App，就改用連得上的平板配對。

要重新配對：停掉容器（`docker compose stop matterbridge`）後刪除 `app/data/matterbridge/`。

Matterbridge 管理頁：插座 App「設定 → Google Home → Matterbridge 管理頁 → 打開」。它在 `http://樹莓派的IP:8283`，但只有從插座 App 點進去的瀏覽器才進得去（拿到 12 小時有效的通行證），直接開會被送回插座 App。Matterbridge 本身只開在樹莓派本機 `127.0.0.1:8284`，門口是 `matterbridge-gate`（nginx，設定在 `matter/nginx.conf`）。建議在管理頁的 Settings 再設一組密碼，多一層保護。Docker 映像用的是 `latest`，要固定版本就改 `docker-compose.yml` 的 `image:`。

## 檔案

| 檔案 | 內容 |
| --- | --- |
| `plughub/hub.py` | 找插座、更新狀態、開關、累計用電、夜間排程、通知 |
| `plughub/main.py` | 網頁伺服器和 API |
| `plughub/store.py` | 設定（`data/store.json`）和每天用電（`data/energy.db`） |
| `plughub/tariff.py` | 台電累進電價表 |
| `plughub/notify.py` | ntfy 通知 |
| `plughub/static/` | 手機網頁 App（`app.js`）、圖示、加入主畫面用的設定 |
| `matter/matterbridge-plughub/` | Google Home 串接：Matterbridge 外掛，把插座 App 的插座變成 Matter 插座 |

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
| PUT | `/api/matter` | Google Home 串接外掛回報配對狀態（只接受樹莓派本機） |
| GET | `/api/matter/qr.svg` | 配對用的 QR code（配對好之後就沒有了） |
| GET | `/matterbridge` | 發通行證並轉到 Matterbridge 管理頁（:8283） |
