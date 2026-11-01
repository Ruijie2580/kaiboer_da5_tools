// WebHID 只负责收发报告。音量拖动不逐格下发：DA5 要整条曲线一次提交，
// 中途的半包会把机身 DSP 写成不完整的状态。

import {
  BANDS,
  CMD_FLASH,
  CMD_GAIN,
  CMD_PEQ,
  CMD_TEMP,
  CMD_VERSION,
  PRODUCT_ID,
  READ,
  REPORT_ID,
  VENDOR_ID,
  WRITE,
  type Band,
  filterPacket,
  parseBand,
} from "./protocol";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Waiter {
  command: number;
  index: number | null;
  resolve: (payload: Uint8Array) => void;
  reject: (error: Error) => void;
  timer: number;
}

export class Da5Link {
  device: HIDDevice | null = null;
  private waiters: Waiter[] = [];

  private onReport = (event: HIDInputReportEvent) => {
    if (event.reportId !== REPORT_ID) return;
    const view = event.data;
    const payload = new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
    if (payload.length < 2 || payload[0] !== READ) return;
    const command = payload[1];
    const at = this.waiters.findIndex(
      (waiter) => waiter.command === command && (waiter.index == null || payload[4] === waiter.index),
    );
    if (at < 0) return;
    const waiter = this.waiters.splice(at, 1)[0];
    window.clearTimeout(waiter.timer);
    waiter.resolve(payload);
  };

  async requestDevice(): Promise<boolean> {
    const devices = await navigator.hid.requestDevice({
      filters: [{ vendorId: VENDOR_ID, productId: PRODUCT_ID }],
    });
    if (!devices.length) return false;
    await this.open(devices[0]);
    return true;
  }

  async reconnect(): Promise<boolean> {
    const devices = await navigator.hid.getDevices();
    const found = devices.find((item) => item.vendorId === VENDOR_ID && item.productId === PRODUCT_ID);
    if (!found) return false;
    await this.open(found);
    return true;
  }

  private async open(device: HIDDevice) {
    if (!device.opened) await device.open();
    this.waiters = [];
    if (this.device && this.device !== device) {
      this.device.removeEventListener("inputreport", this.onReport);
    }
    this.device = device;
    device.addEventListener("inputreport", this.onReport);
  }

  close() {
    const device = this.device;
    this.device = null;
    this.failWaiters(new Error("连接已断开"));
    if (!device) return;
    device.removeEventListener("inputreport", this.onReport);
    device.close().catch(() => {});
  }

  dropped(device: HIDDevice) {
    if (this.device === device) this.close();
  }

  private failWaiters(error: Error) {
    for (const waiter of this.waiters) {
      window.clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters = [];
  }

  private async send(payload: number[]) {
    if (!this.device) throw new Error("还没有连接声卡");
    const data = new Uint8Array(63);
    data.set(payload.slice(0, 63));
    await this.device.sendReport(REPORT_ID, data);
  }

  private request(payload: number[], command: number, index: number | null = null, timeout = 1500) {
    return new Promise<Uint8Array>((resolve, reject) => {
      const waiter: Waiter = { command, index, resolve, reject, timer: 0 };
      waiter.timer = window.setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        reject(new Error("声卡没有在预期时间内回应"));
      }, timeout);
      this.waiters.push(waiter);
      this.send(payload).catch((error: unknown) => {
        window.clearTimeout(waiter.timer);
        this.waiters = this.waiters.filter((item) => item !== waiter);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async readFirmware(): Promise<string> {
    const payload = await this.request([READ, CMD_VERSION, 0x00], CMD_VERSION);
    const text = String.fromCharCode(...payload.slice(3, 7)).replace(/\0.*/, "").trim();
    return text || "未知";
  }

  async readPreamp(): Promise<number> {
    const payload = await this.request([READ, CMD_GAIN, 0x00], CMD_GAIN);
    const raw = payload[4];
    return raw > 127 ? raw - 256 : raw;
  }

  async readBands(): Promise<Band[]> {
    const bands: Band[] = [];
    for (let index = 0; index < BANDS; index += 1) {
      let band: Band | null = null;
      for (let attempt = 0; attempt < 3 && !band; attempt += 1) {
        try {
          const payload = await this.request(
            [READ, CMD_PEQ, 0x00, 0x00, index, 0x00],
            CMD_PEQ,
            index,
            800,
          );
          band = parseBand(payload);
        } catch (error) {
          if (attempt === 2) throw error;
        }
      }
      if (!band) throw new Error(`没有读到第 ${index + 1} 段`);
      bands.push(band);
    }
    return bands;
  }

  async readAll() {
    return {
      firmware: await this.readFirmware(),
      preamp: await this.readPreamp(),
      bands: await this.readBands(),
      name: this.device?.productName || "DA5",
    };
  }

  async writeProfile(bands: Band[], preamp: number) {
    const level = Math.max(-12, Math.min(0, Math.round(preamp))) & 0xff;
    for (let index = 0; index < BANDS; index += 1) {
      await this.send(filterPacket(index, bands[index]));
      await sleep(20);
    }
    await sleep(80);
    await this.send([WRITE, CMD_GAIN, 0x02, 0x00, level]);
    await sleep(50);
    const tail: Array<[number[], number]> = [
      [[WRITE, 0x05, 0x00], 20],
      [[WRITE, 0x17, 0x00], 20],
      [[WRITE, CMD_TEMP, 0x04, 0x00, 0x00, 0xff, 0xff, 0x00], 50],
      [[WRITE, CMD_FLASH, 0x00], 80],
      [[WRITE, CMD_FLASH, 0x01, 0x00, 0x00], 120],
    ];
    for (const [payload, pause] of tail) {
      await this.send(payload);
      await sleep(pause);
    }
    await sleep(150);
  }

  async setEnabled(enabled: boolean) {
    if (enabled) await this.send([WRITE, CMD_FLASH, 0x01, 0x00, 0x00]);
    else await this.send([WRITE, CMD_FLASH, 0x00, 0x00, 0x00]);
    await sleep(50);
  }
}
