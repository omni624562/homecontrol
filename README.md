# homecontrol

家裡 TP-Link Tapo／Kasa 插座的電源管理：用樹莓派跑 Home Assistant，在區域網路內直接控制插座、記錄用電、估算電費，手機（Android／iPhone）上用自訂儀表板操作，有待機與功率過高的通知。

```
手機（Home Assistant App，在外面時透過 Tailscale 連回家裡）
   │
   ▼
Raspberry Pi 5：Home Assistant OS ──每天備份──→ NAS
   │  區域網路
   ▼
Tapo P110 / Kasa KP115 插座（原本的 Google Home 語音照樣能用）
```

## 檔案

| 檔案 | 內容 |
| --- | --- |
| `packages/power.yaml` | 插座清單、電價與門檻、總功率、今日／本月用電與電費、「全部關閉」「關閉待機中的」腳本、通知 |
| `packages/power_automations.yaml` | 每天 23:00 待機提醒（通知上可一鍵關閉）、單一插座功率過高警告 |
| `dashboards/power.yaml` | 手機用電儀表板 |

## 需要準備

- Raspberry Pi 5（建議 4GB 以上）、官方 27W 電源供應器、官方 Active Cooler
- USB 或 M.2 的 SSD（比 SD 卡耐用；只用 SD 卡請選 A2 等級）
- 網路線
- 路由器上把樹莓派和每個插座設成固定 IP（DHCP 保留）

## 安裝

### 1. 插座開啟第三方相容性

新版韌體沒開的話，Home Assistant 可能連不上。

- Tapo App：我 → Tapo Lab → 第三方相容性（Third-Party Compatibility）
- Kasa App：設定 → 第三方相容性

### 2. 安裝 Home Assistant OS

1. 電腦上開 Raspberry Pi Imager：Raspberry Pi 5 → Other specific-purpose OS → Home assistants and home automation → Home Assistant OS，寫入 SSD 或 SD 卡
2. 樹莓派接網路線開機，幾分鐘後開 `http://homeassistant.local:8123` 建立帳號
3. 地區選台灣、時區 Asia/Taipei、貨幣 TWD

### 3. 加入插座並改名

1. 設定 → 裝置與服務：通常會自動找到「TP-Link Smart Home」，用 TP-Link 帳號登入（Tapo 和 Kasa 是同一組帳號）
2. 每個插座的裝置頁 → 右上角鉛筆 → 名稱改成**簡短英文**（例如 `tv`、`pc`），出現「要更新實體 ID 嗎」時選更新
3. 確認實體 ID 符合下面的規則（設定 → 實體，搜尋插座名稱）：

   | 用途 | 實體 ID |
   | --- | --- |
   | 開關 | `switch.tv` |
   | 即時功率（W） | `sensor.tv_current_consumption` |
   | 累計用電（kWh） | `sensor.tv_total_consumption` |

   名稱對好之後，儀表板上顯示的中文名稱可以在儀表板裡另外設定。

### 4. 放入設定檔

1. 附加元件商店安裝「Studio Code Server」或「File editor」（也可以用「Samba share」從電腦複製）
2. 把 `packages/` 整個資料夾複製到 `/config/packages/`
3. 打開 `/config/configuration.yaml`，在最上面加入（已經有 `homeassistant:` 的話，把 `packages` 那行加進去）：

   ```yaml
   homeassistant:
     packages: !include_dir_named packages
   ```

4. 依照你家的插座修改 `packages/power.yaml`：
   - `power_plugs`：列出所有要管理的插座
   - `power_plugs_keep_on`：冰箱、網路設備等不能斷電的插座，例如：

     ```yaml
     power_plugs_keep_on:
       name: 常開插座
       entities:
         - switch.fridge
     ```

   - `power_notify` 裡的 `notify.mobile_app_my_phone`：換成你手機的通知名稱（第 6 步裝好手機 App 後，到開發者工具 → 動作，搜尋 `mobile_app`）
5. 開發者工具 → YAML → 「檢查設定」，沒有錯誤再按「重新啟動」

### 5. 設定電價與門檻

重新啟動後到設定 → 實體，或儀表板最下面的「設定」區塊：

| 項目 | 建議值 |
| --- | --- |
| 平均電價 | 電費單的「總金額 ÷ 總度數」（台電是累進電價，用平均值估算） |
| 待機門檻 | 5 W：插座開著、但低於這個值就當作電器在待機 |
| 功率過高門檻 | 1500 W：110V 插座一般 15A，持續超過 1500 W 就提醒 |

### 6. 手機

1. 安裝 Home Assistant App（Android／iOS），登入後允許通知
2. 回到第 4 步，填好通知名稱並重新啟動
3. 設定 → 儀表板 → 新增儀表板 →「從頭開始」，命名「用電」→ 打開 → ⋮ → 編輯儀表板 → ⋮ →「原始設定編輯器」→ 貼上 `dashboards/power.yaml` 的內容並儲存
4. App 的設定 → 隨附應用程式 → 可以把「用電」設成預設儀表板

### 7. 能源儀表板

設定 → 儀表板 → 能源 → 個別裝置 → 把每個插座的 `*_total_consumption` 加進去，就有內建的每日／每月用電圖表。

### 8. 在外面時連回家裡

1. 附加元件商店安裝「Tailscale」並啟動、登入
2. 手機安裝 Tailscale App，用同一個帳號登入
3. Home Assistant App 的伺服器網址加上 Tailscale 給樹莓派的位址（`http://100.x.x.x:8123`）

不需要在路由器上開放任何連接埠。

### 9. 備份到 NAS

1. NAS 上開一個共用資料夾，啟用 SMB
2. Home Assistant：設定 → 系統 → 儲存 → 新增網路儲存，用途選「備份」
3. 設定 → 系統 → 備份 → 自動備份，位置選 NAS，每天備份

樹莓派壞了的話，重新安裝 Home Assistant OS 後，從 NAS 上的備份就能完整還原。

## 新增插座

1. 照第 3 步加入並改成英文名稱
2. `packages/power.yaml` 的 `power_plugs` 加上新插座的開關（總功率、用電、電費、通知都會自動包含它）
3. 開發者工具 → YAML → 重新載入「群組」
4. 儀表板的「插座」和兩張圖表裡各加一組

## 名稱和這份設定不一樣時

TP-Link 整合的功率和累計用電感測器，英文名稱是「Current consumption」「Total consumption」（繁體中文介面顯示為「目前耗能」「總耗能」）。介面設成繁體中文時，實體 ID 仍然用英文名稱產生，所以字尾一樣是 `_current_consumption`、`_total_consumption`。

最常見的不符是插座名稱用中文：例如裝置叫「電視」，實體 ID 會變成拼音 `sensor.dian_shi_current_consumption`。照第 3 步把裝置改成英文名稱並更新實體 ID 就好。

若還是不符，有兩個做法：

- 在每個感測器的設定裡把實體 ID 改成上面的規則（建議）
- 或是把 `packages/` 和 `dashboards/` 裡的這兩個字尾全部換成實際的名稱

## 通知

| 通知 | 時機 | 按鈕 |
| --- | --- | --- |
| 有插座在待機 | 每天 23:00，有插座開著但功率在 0.2 W 和待機門檻之間 | 「全部關閉」：關掉這些插座（常開插座除外） |
| 插座功率過高 | 任何一個插座超過門檻持續 1 分鐘 | 無 |

提醒時間改 `packages/power_automations.yaml` 裡的 `at: "23:00:00"`。
