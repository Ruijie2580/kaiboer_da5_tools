import * as Dialog from "@radix-ui/react-dialog";
import { PRODUCT_ID, VENDOR_ID } from "../hid/protocol";

interface DeviceDialogProps {
  firmware: string;
  connected: boolean;
}

export function DeviceDialog({ firmware, connected }: DeviceDialogProps) {
  return (
    <Dialog.Root>
      <Dialog.Trigger className="key">设备</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-900/20 backdrop-blur-md" />
        <Dialog.Content className="glass fixed left-1/2 top-1/2 z-50 w-[min(460px,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl p-5">
          <Dialog.Title className="text-lg font-semibold">设备信息</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-slate-500">
            只显示这块 DA5 实际能通过 HID 读到的内容。
          </Dialog.Description>
          <dl className="mt-4 grid grid-cols-[88px_1fr] gap-y-2 text-sm tabular-nums">
            <dt className="text-slate-500">设备</dt>
            <dd>开博尔 DA5</dd>
            <dt className="text-slate-500">USB</dt>
            <dd>{VENDOR_ID.toString(16).toUpperCase()}:{PRODUCT_ID.toString(16).toUpperCase()}</dd>
            <dt className="text-slate-500">报告</dt>
            <dd>0x4B · 10 段参量均衡</dd>
            <dt className="text-slate-500">固件</dt>
            <dd>{connected ? firmware || "读取中" : "未连接"}</dd>
            <dt className="text-slate-500">系数</dt>
            <dd>按 96 kHz 计算，不是当前播放采样率</dd>
          </dl>
          <ul className="mt-4 space-y-2 text-sm leading-6 text-slate-600">
            <li>标准 / 高增益是机身侧面的拨动开关，软件改不了。</li>
            <li>3.5 mm 和 4.4 mm 由插孔决定，没有输出切换指令。</li>
            <li>快滚降、慢滚降没有对应指令，面板不提供滤波切换。</li>
            <li>这套 HID 没有固件刷写入口，这里不会写入升级数据。</li>
          </ul>
          <div className="mt-5 flex justify-end">
            <Dialog.Close className="key primary">知道了</Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
