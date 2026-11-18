// Matterbridge 外掛：把插座 App（plughub）的每個插座變成 Matter 插座，
// 讓 Google Home（或 Apple Home、Alexa）在家裡直接控制，不經過 TP-Link 雲端。
//
// 插座 App 是唯一真正連插座的程式；這個外掛只是轉接：
//   Google Home 按開關 → Matter 指令 → POST /api/plugs/{id}/power
//   插座狀態改變     → /api/events 推送 → 更新 Matter 的開關狀態

import { createHash } from 'node:crypto';
import { MatterbridgeDynamicPlatform, MatterbridgeEndpoint, bridgedNode, onOffPlugInUnit, powerSource } from 'matterbridge';
import { BridgedDeviceBasicInformation, OnOff } from 'matterbridge/matter/clusters';

// Matter 控制器的廠商代號 → 名稱（配對到哪些平台）
const VENDORS = { 0x6006: 'Google Home', 0x1349: 'Apple 家庭', 0x1217: 'Amazon Alexa', 0x110a: 'SmartThings', 0x134b: 'Home Assistant' };

export default function initializePlugin(matterbridge, log, config) {
  return new PlughubPlatform(matterbridge, log, config);
}

// Matter 的名稱最多 32 bytes（中文一個字 3 bytes），超過就截斷
function matterName(name) {
  const enc = new TextEncoder();
  let out = '';
  for (const ch of name) {
    if (enc.encode(out + ch).length > 32) break;
    out += ch;
  }
  return out || 'Plug';
}

// 插座 ID 太長（排插的孔有 58 字），序號最多 32 字，用雜湊縮短；同一個插座永遠得到同一個序號
function serialOf(plugId) {
  return 'PH' + createHash('sha1').update(plugId).digest('hex').slice(0, 16);
}

export class PlughubPlatform extends MatterbridgeDynamicPlatform {
  constructor(matterbridge, log, config) {
    super(matterbridge, log, config);
    this.url = String(config.url || 'http://127.0.0.1:8100').replace(/\/$/, '');
    this.devices = new Map(); // 插座 ID → MatterbridgeEndpoint
    this.state = new Map(); // 插座 ID → 最後一次的插座資料
    this.abort = undefined;
    this.stopped = false;
    this.reportTimer = undefined;
  }

  async api(path, options = {}) {
    const res = await fetch(this.url + path, {
      ...options,
      headers: { 'Content-Type': 'application/json' },
      signal: options.signal ?? AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`${path} 回應 ${res.status}：${await res.text()}`);
    return res.json();
  }

  async onStart(reason) {
    this.log.info(`啟動插座橋接（${reason ?? ''}），插座 App：${this.url}`);
    await this.ready;
    await this.clearSelect();
    // 插座 App 可能還在啟動，等它回應
    let snapshot;
    for (let i = 0; !snapshot; i++) {
      try {
        snapshot = await this.api('/api/state');
      } catch (err) {
        if (i % 6 === 0) this.log.warn(`連不上插座 App，5 秒後再試：${err.message}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    for (const plug of snapshot.plugs) await this.addPlug(plug);
    this.log.info(`已加入 ${this.devices.size} 個插座`);
    this.listen();
  }

  async onConfigure() {
    await super.onConfigure();
    for (const plug of this.state.values()) await this.applyState(plug);
    this.watchPairing();
  }

  async onShutdown(reason) {
    this.stopped = true;
    this.abort?.abort();
    clearInterval(this.reportTimer);
    await super.onShutdown(reason);
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }

  async addPlug(plug) {
    const serial = serialOf(plug.id);
    const name = matterName(plug.name);
    this.setSelectDevice(serial, name, undefined, 'hub');
    if (!this.validateDevice(name)) return;
    const device = new MatterbridgeEndpoint([onOffPlugInUnit, bridgedNode, powerSource], { id: serial }, this.config.debug)
      .createDefaultIdentifyClusterServer()
      .createDefaultBridgedDeviceBasicInformationClusterServer(name, serial, 0xfff1, 'TP-Link', plug.model || 'Kasa')
      .createDefaultOnOffClusterServer(Boolean(plug.is_on))
      .createDefaultPowerSourceWiredClusterServer()
      .addRequiredClusterServers();
    device.addCommandHandler('identify', () => {});
    device.addCommandHandler('on', () => this.command(plug.id, true));
    device.addCommandHandler('off', () => this.command(plug.id, false));
    device.addCommandHandler('toggle', () => this.command(plug.id, !this.state.get(plug.id)?.is_on));
    await this.registerDevice(device);
    this.devices.set(plug.id, device);
    this.state.set(plug.id, plug);
  }

  async command(plugId, on) {
    this.log.info(`Google Home：${this.state.get(plugId)?.name ?? plugId} → ${on ? '開' : '關'}`);
    try {
      await this.api(`/api/plugs/${encodeURIComponent(plugId)}/power`, {
        method: 'POST',
        body: JSON.stringify({ on }),
      });
    } catch (err) {
      this.log.error(`開關失敗：${err.message}`);
      // 失敗就把 Google Home 上的開關改回插座真正的狀態
      const plug = this.state.get(plugId);
      if (plug) setTimeout(() => this.applyState(plug, true), 500);
    }
  }

  async applyState(plug, force = false) {
    const device = this.devices.get(plug.id);
    if (!device) return;
    const old = this.state.get(plug.id);
    this.state.set(plug.id, plug);
    try {
      if (force || old?.is_on !== plug.is_on) await device.setAttribute(OnOff.id, 'onOff', Boolean(plug.is_on), device.log);
      if (force || old?.online !== plug.online)
        await device.setAttribute(BridgedDeviceBasicInformation.id, 'reachable', Boolean(plug.online), device.log);
    } catch (err) {
      this.log.debug(`更新狀態失敗：${err.message}`);
    }
  }

  async onSnapshot(snapshot) {
    const seen = new Set();
    for (const plug of snapshot.plugs) {
      seen.add(plug.id);
      if (this.devices.has(plug.id)) await this.applyState(plug);
      else {
        // 新找到的插座：直接加進來
        try {
          await this.addPlug(plug);
          this.log.info(`新插座：${plug.name}`);
        } catch (err) {
          this.log.warn(`新插座 ${plug.name} 要重新啟動橋接後才會出現：${err.message}`);
        }
      }
    }
    // 插座 App 不再列出的插座，顯示為離線
    for (const [id, plug] of this.state) {
      if (!seen.has(id) && plug.online) await this.applyState({ ...plug, online: false });
    }
  }

  // ---- 配對狀態：回報給插座 App，讓它在設定頁顯示 QR code 和「已連上 Google Home」----

  // 外掛拿不到 Matterbridge 本身，從自己的插座往上找到 Matter 節點
  serverNode() {
    let node = this.devices.values().next().value;
    while (node?.owner) node = node.owner;
    return node?.state?.commissioning ? node : undefined;
  }

  pairingStatus() {
    const node = this.serverNode();
    if (!node) return undefined;
    const { qrPairingCode, manualPairingCode } = node.state.commissioning.pairingCodes;
    const fabrics = Object.values(node.state.commissioning.fabrics ?? {}).map((f) => ({
      vendor: VENDORS[f.rootVendorId] ?? `廠商 ${f.rootVendorId}`,
      label: f.label ?? '',
    }));
    return {
      online: node.lifecycle.isOnline,
      commissioned: node.lifecycle.isCommissioned,
      qr_code: qrPairingCode,
      manual_code: manualPairingCode,
      fabrics,
      plugs: this.devices.size,
    };
  }

  async reportPairing() {
    const status = this.pairingStatus();
    if (!status) return;
    try {
      await this.api('/api/matter', { method: 'PUT', body: JSON.stringify(status) });
    } catch (err) {
      this.log.debug(`回報配對狀態失敗：${err.message}`);
    }
  }

  watchPairing() {
    const node = this.serverNode();
    if (!node) {
      this.log.warn('找不到 Matter 節點，插座 App 不會顯示配對狀態（要用 bridge 模式啟動）');
      return;
    }
    const report = () => setTimeout(() => this.reportPairing(), 1000);
    node.lifecycle.commissioned?.on(report);
    node.lifecycle.decommissioned?.on(report);
    node.lifecycle.online?.on(report);
    node.events?.commissioning?.fabricsChanged?.on(report);
    clearInterval(this.reportTimer);
    this.reportTimer = setInterval(() => this.reportPairing(), 30000);
    this.reportPairing();
  }

  // 收插座 App 的即時推送；斷線就重連
  async listen() {
    while (!this.stopped) {
      this.abort = new AbortController();
      let watchdog;
      const kick = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => this.abort.abort(), 45000); // App 每 15 秒會送 ping
      };
      try {
        const res = await fetch(this.url + '/api/events', { signal: this.abort.signal });
        if (!res.ok) throw new Error(`回應 ${res.status}`);
        kick();
        const decoder = new TextDecoder();
        let buffer = '';
        for await (const chunk of res.body) {
          kick();
          buffer += decoder.decode(chunk, { stream: true });
          let cut;
          while ((cut = buffer.indexOf('\n\n')) >= 0) {
            const message = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const data = message
              .split('\n')
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trimStart())
              .join('\n');
            if (data) await this.onSnapshot(JSON.parse(data));
          }
        }
      } catch (err) {
        if (!this.stopped) this.log.warn(`和插座 App 的連線中斷，5 秒後重連：${err.message}`);
      } finally {
        clearTimeout(watchdog);
      }
      if (!this.stopped) await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
