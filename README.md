# homecontrol

[![CI](https://github.com/omni624562/homecontrol/actions/workflows/ci.yml/badge.svg)](https://github.com/omni624562/homecontrol/actions/workflows/ci.yml)

家庭中控：樹莓派上一個小伺服器加手機網頁 App，直接在區網控制 TP-Link Kasa／Tapo 插座，不用帳號、不經過雲端。
排程、情境、防呆、用電與電費、誰在家、Google Home（Matter）、天氣與生活資訊、「問家裡」（Claude）。

<p>
  <img src="docs/app-light.png" width="300" alt="插座 App">
  <img src="docs/app-dark.png" width="300" alt="插座 App 深色模式">
</p>

**說明、安裝、API 都在 [`app/README.md`](app/README.md)。**

```bash
cd app
./deploy.sh          # 第一次安裝、之後每次 git pull 完都執行這個
```

手機打開 `http://樹莓派的IP:8100`，第一次要輸入配對碼（見 [配對](app/README.md#配對)）。

| 資料夾 | 內容 |
| --- | --- |
| [`app/`](app/) | 家庭中控（Python FastAPI + React），現在用的版本 |
| [`app/tests/`](app/tests/) | 測試（`cd app && python -m pytest`），GitHub Actions 每次 push 都會跑 |
| [`home-assistant/`](home-assistant/) | 原本的 Home Assistant 整合，**已封存**，不再維護 |

版本號用 git tag（`v1.0.0`…），設定頁「安全與備份」和 `/api/health` 會顯示目前執行的版本。
