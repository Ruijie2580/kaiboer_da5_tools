// 这台 TypeScript 的 DOM 库没有带上 WebHID，只声明本面板用到的部分。

interface HIDDevice {
  opened: boolean;
  vendorId: number;
  productId: number;
  productName: string;
  open(): Promise<void>;
  close(): Promise<void>;
  sendReport(reportId: number, data: BufferSource): Promise<void>;
  addEventListener(type: "inputreport", listener: (event: HIDInputReportEvent) => void): void;
  removeEventListener(type: "inputreport", listener: (event: HIDInputReportEvent) => void): void;
}

interface HIDInputReportEvent extends Event {
  reportId: number;
  device: HIDDevice;
  data: DataView;
}

interface HIDConnectionEvent extends Event {
  device: HIDDevice;
}

interface HID {
  requestDevice(options: { filters: Array<{ vendorId?: number; productId?: number }> }): Promise<HIDDevice[]>;
  getDevices(): Promise<HIDDevice[]>;
  addEventListener(type: "disconnect", listener: (event: HIDConnectionEvent) => void): void;
  removeEventListener(type: "disconnect", listener: (event: HIDConnectionEvent) => void): void;
}

interface Navigator {
  hid: HID;
}
